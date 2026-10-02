// Firefox replacement for chrome.tabCapture.capture() used by the popup's
// recorder. It injects ff-capture-content.js into every frame of the active
// tab, connects a port to each frame, and mixes the PCM the frames stream back.
// Once no frame has anything playing, a clock feeds silence, so the recorder
// behaves as with a silent tab under tabCapture (listening, then the 3 s
// "no music" result) and still picks up media that starts late.
//
// The original recorder builds a Web Audio graph on the captured MediaStream
// and reads samples from a ScriptProcessor. Instead of a real MediaStream this
// hands back lightweight stand-ins for the few AudioContext / node / track
// methods the recorder touches, and feeds the mixed chunks straight into its
// onaudioprocess handler.
(() => {
  const CONTENT_SCRIPT = "/ff-capture-content.js";
  const PORT_NAME = "ff-shazam-capture";
  const BUFFER_SIZE = 4096;
  const MAX_QUEUED_CHUNKS = 8;
  const MAX_PREROLL_CHUNKS = 36;
  const REPROBE_MS = 1000;
  // How long to wait for a frame that has media but has not streamed yet
  // (e.g. its main thread is busy) before counting its time as silence.
  const SILENCE_HOLD_MS = 2000;
  // The popup sends stopRecording on every render and the background echoes
  // each one back. tabCapture answers after those echoes have arrived; a
  // faster start would let a late echo cancel the new recording. Audio from
  // this window is kept and handed over as pre-roll.
  const MIN_START_MS = 250;
  // Cancel button of the listening view: gone once the user cancelled.
  const LISTENING_UI = ".li4ou6PVyauMoiqDcF2y";

  let current = null;

  const defaultSampleRate = () => {
    try {
      const ctx = new AudioContext();
      const rate = ctx.sampleRate;
      ctx.close().catch(() => {});
      return rate;
    } catch {
      return 48000;
    }
  };

  const findActiveTabId = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab ? tab.id : null;
    } catch {
      return null;
    }
  };

  const createSession = (tabId, startedAt) => {
    let sampleRate = defaultSampleRate();
    const blockMs = () => (BUFFER_SIZE / sampleRate) * 1000;
    const sources = new Map();
    const preroll = [];
    let processor = null;
    let delivered = false;
    let driver = null;
    let everDriven = false;
    let firstProbeDone = false;
    let holdExpired = false;
    let silenceTimer = null;
    let silenceStart = 0;
    let silenceBlocks = 0;
    let reprobeTimer = null;
    let tabAudible = false;
    let stopped = false;

    const deliver = (samples) => {
      if (stopped) return;
      if (!delivered) {
        preroll.push(samples);
        if (preroll.length > MAX_PREROLL_CHUNKS) preroll.shift();
        return;
      }
      if (!processor || !processor.onaudioprocess) return;
      processor.onaudioprocess({
        inputBuffer: {
          numberOfChannels: 1,
          length: samples.length,
          sampleRate,
          getChannelData: () => samples,
        },
      });
    };

    // Chunks from the driving frame set the pace; the other frames' queued
    // chunks are summed into them, clamped like the tab mix tabCapture records.
    const mixAndDeliver = (base) => {
      const out = new Float32Array(base);
      for (const [frameId, source] of sources) {
        if (frameId === driver || !source.queue.length) continue;
        const chunk = source.queue.shift();
        const n = Math.min(out.length, chunk.length);
        for (let i = 0; i < n; i++) out[i] += chunk[i];
      }
      for (let i = 0; i < out.length; i++) {
        if (out[i] > 1) out[i] = 1;
        else if (out[i] < -1) out[i] = -1;
      }
      deliver(out);
    };

    // Silence stands in for the tab's output only once no frame is expected
    // to stream. Started late, it back-fills from the capture start so a
    // silent tab still gets its result on time.
    const silenceAllowed = () => {
      if (holdExpired) return true;
      if (!firstProbeDone) return false;
      for (const source of sources.values()) {
        if (!source.reported || source.playing > 0) return false;
      }
      return true;
    };
    const silenceTick = () => {
      const target = Math.floor((performance.now() - silenceStart) / blockMs());
      const zeros = new Float32Array(BUFFER_SIZE);
      while (silenceBlocks < target && silenceTimer) {
        silenceBlocks++;
        mixAndDeliver(zeros);
      }
    };
    const updateSilence = () => {
      const active = !stopped && driver === null && silenceAllowed();
      if (active && !silenceTimer) {
        silenceStart = everDriven ? performance.now() : startedAt;
        silenceBlocks = 0;
        silenceTimer = setInterval(silenceTick, blockMs() / 2);
        silenceTick();
      } else if (!active && silenceTimer) {
        clearInterval(silenceTimer);
        silenceTimer = null;
      }
    };
    const holdTimer = setTimeout(() => {
      holdExpired = true;
      updateSilence();
    }, SILENCE_HOLD_MS);

    const pickDriver = () => {
      driver = null;
      for (const [frameId, source] of sources) {
        if (source.started) {
          driver = frameId;
          everDriven = true;
          source.queue.length = 0;
          break;
        }
      }
      updateSilence();
    };

    const dropSource = (frameId) => {
      const source = sources.get(frameId);
      if (!source) return;
      sources.delete(frameId);
      try {
        source.port.disconnect();
      } catch {}
      if (driver === frameId) pickDriver();
      else updateSilence();
    };

    const connectFrame = (frameId) => {
      if (stopped || sources.has(frameId)) return;
      let port;
      try {
        // Frames create their capture context at the session's rate.
        port = chrome.tabs.connect(tabId, { name: `${PORT_NAME}@${sampleRate}`, frameId });
      } catch {
        return;
      }
      const source = { port, reported: false, playing: 0, started: false, queue: [] };
      sources.set(frameId, source);
      port.onMessage.addListener((msg) => {
        if (stopped) return;
        if (msg.type === "state") {
          source.reported = true;
          source.playing = msg.playing;
          updateSilence();
        } else if (msg.type === "started") {
          if (!everDriven && driver === null) {
            // Take the page's rate (it can differ, e.g. with
            // privacy.resistFingerprinting) as long as nothing real was mixed.
            sampleRate = msg.sampleRate;
            context.sampleRate = msg.sampleRate;
          } else if (msg.sampleRate !== sampleRate) {
            console.warn(`[shazam-firefox] frame ${frameId} runs at ${msg.sampleRate} Hz, mixing at ${sampleRate} Hz`);
            return;
          }
          source.started = true;
          if (driver === null) pickDriver();
        } else if (msg.type === "pcm" && source.started) {
          const samples = msg.samples instanceof Float32Array ? msg.samples : Float32Array.from(msg.samples);
          if (frameId === driver) {
            mixAndDeliver(samples);
          } else {
            source.queue.push(samples);
            if (source.queue.length > MAX_QUEUED_CHUNKS) source.queue.shift();
          }
        }
      });
      // Reload or navigation of the frame drops its port (the page ends the
      // capture on pagehide, also when it goes into the back-forward cache);
      // find the new document.
      port.onDisconnect.addListener(() => {
        if (sources.get(frameId) !== source) return;
        dropSource(frameId);
        scheduleProbe(250);
      });
    };

    const probe = async (target) => {
      if (stopped || tabId === null) return;
      let results;
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId, ...target },
          files: [CONTENT_SCRIPT],
          // Don't wait for frames that are still parsing.
          injectImmediately: true,
        });
      } catch {
        return;
      }
      for (const entry of results || []) {
        if (entry && !entry.error) connectFrame(entry.frameId);
      }
    };

    // Frame 0 alone answers fast; the all-frames call waits for every frame's
    // process, which a busy cross-origin frame can stall for seconds.
    const probeAll = () => {
      // A tab that makes sound while nothing streams has media the frames
      // have not found yet (e.g. in a shadow root attached later).
      if (tabAudible && driver === null) {
        for (const source of sources.values()) {
          try {
            source.port.postMessage({ type: "rescan" });
          } catch {}
        }
      }
      return Promise.all([probe({ frameIds: [0] }), probe({ allFrames: true })]);
    };

    const scheduleProbe = (delay) => {
      if (stopped || reprobeTimer) return;
      reprobeTimer = setTimeout(() => {
        reprobeTimer = null;
        probeAll();
      }, delay);
    };
    // Frames can be added at any time while listening.
    const periodicProbe = setInterval(probeAll, REPROBE_MS);

    // A new document, or a tab that just started making sound, may have
    // frames to connect.
    const onTabUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || stopped) return;
      if (changeInfo.audible !== undefined) tabAudible = changeInfo.audible;
      if (changeInfo.status === "complete" || changeInfo.audible === true) scheduleProbe(0);
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(periodicProbe);
      clearTimeout(holdTimer);
      clearTimeout(reprobeTimer);
      updateSilence();
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      for (const source of sources.values()) {
        try {
          source.port.disconnect();
        } catch {}
      }
      sources.clear();
    };

    const createNode = () => ({ connect() {}, disconnect() {} });
    const context = {
      sampleRate,
      state: "running",
      ffPrerollMs: 0,
      destination: createNode(),
      createGain: createNode,
      createScriptProcessor() {
        processor = { ...createNode(), onaudioprocess: null };
        return processor;
      },
      close() {
        stop();
        context.state = "closed";
        return Promise.resolve();
      },
    };
    const track = { kind: "audio", stop };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
      ffContext: context,
      ffSource: { ...createNode(), context },
    };

    return {
      stop,
      isStopped: () => stopped,
      start: () => {
        if (tabId !== null) {
          chrome.tabs.onUpdated.addListener(onTabUpdated);
          chrome.tabs.get(tabId).then(
            (tab) => {
              if (!stopped && tab.audible) tabAudible = true;
            },
            () => {},
          );
        }
        return probeAll().finally(() => {
          firstProbeDone = true;
          updateSilence();
        });
      },
      // Hands the stream to the recorder, then replays the audio captured
      // since startedAt; the recorder shortens its first timers by that much.
      deliverTo: (callback) => {
        context.ffPrerollMs = performance.now() - startedAt;
        callback(stream);
        delivered = true;
        for (const samples of preroll.splice(0)) deliver(samples);
      },
    };
  };

  const BUSY = { ffBusy: true, ffContext: { state: "running", close: () => Promise.resolve() } };

  globalThis.ffTabCapture = {
    capture(options, callback) {
      const listeningUi = document.querySelector(LISTENING_UI);
      if (current && current.isLive()) {
        const pending = current;
        // A Cancel before the pending capture reached the recorder, followed
        // by a new start, supersedes it.
        if (!pending.delivered && pending.cancelled()) {
          pending.abort();
        } else {
          // tabCapture refuses a second capture of a tab with an active stream,
          // after the first capture has called back.
          pending.settled.then((ok) =>
            ok ? setTimeout(() => callback(BUSY), 0) : globalThis.ffTabCapture.capture(options, callback),
          );
          return;
        }
      }

      const startedAt = performance.now();
      let settle;
      const slot = {
        session: null,
        delivered: false,
        aborted: false,
        settled: new Promise((resolve) => {
          settle = resolve;
        }),
        cancelled: () => (listeningUi ? !listeningUi.isConnected : !document.querySelector(LISTENING_UI)),
        isLive: () => !slot.aborted && !(slot.session && slot.session.isStopped()),
        abort: () => {
          slot.aborted = true;
          if (slot.session) slot.session.stop();
          if (current === slot) current = null;
          settle(false);
        },
      };
      current = slot;

      (async () => {
        const session = createSession(await findActiveTabId(), startedAt);
        if (slot.aborted) {
          session.stop();
          return;
        }
        slot.session = session;
        session.start();
        const wait = MIN_START_MS - (performance.now() - startedAt);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (slot.aborted) return;
        // A Cancel pressed before the recorder existed would be lost.
        if (slot.cancelled()) {
          slot.abort();
          return;
        }
        slot.delivered = true;
        session.deliverTo(callback);
        settle(true);
      })().catch((err) => {
        console.warn("[shazam-firefox] capture failed:", err);
        const wasCancelled = slot.cancelled();
        slot.abort();
        if (!wasCancelled) callback(null);
      });
    },
  };
})();
