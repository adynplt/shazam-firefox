// Injected into every frame of the active tab by ff-tabcapture.js.
// Firefox has no tabCapture API, so this script approximates the tab's audio
// output for its frame: every playing <audio>/<video> is tapped with
// captureStream(), scaled by the element's own volume/mute (tabCapture records
// what the tab outputs), mixed, and streamed to the popup as mono Float32 PCM
// chunks over a runtime port.
(() => {
  if (!window.__ffShazamCapture) {
    const PORT_NAME = "ff-shazam-capture";
    const BUFFER_SIZE = 4096;
    // New media and shadow roots are found through MutationObservers; this
    // slow walk only catches shadow roots attached to elements already in the
    // page. It stops on pages where a walk is expensive; the popup then asks
    // for a rescan whenever the tab makes sound without anything streaming.
    const RESCAN_MS = 3000;
    const SLOW_WALK_MS = 30;
    // A walk gives the page's main thread back after this long.
    const WALK_SLICE_MS = 4;
    // How long a wrapped element's capture may stay digitally silent before
    // it is re-seeked (see attach()).
    const WRAP_CHECK_MS = 250;

    const shadowOf = (el) => el.openOrClosedShadowRoot || el.shadowRoot;

    // Media in a subtree, including open and closed shadow roots below it.
    // A generator that yields whenever it has held the main thread for a
    // slice, so a huge page is walked without a long stall. `stats.busy`
    // accumulates the time actually spent walking.
    const collectMedia = function* (start, media, shadowRoots, stats) {
      const pending = [start];
      let sliceStart = performance.now();
      let visited = 0;
      while (pending.length) {
        const node = pending.pop();
        if (node instanceof HTMLMediaElement) media.push(node);
        const own = node instanceof Element ? shadowOf(node) : null;
        if (own) {
          shadowRoots.push(own);
          pending.push(own);
        }
        if (!node.querySelectorAll) continue;
        media.push(...node.querySelectorAll("audio, video"));
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
        for (let el = walker.nextNode(); el; el = walker.nextNode()) {
          const shadow = shadowOf(el);
          if (shadow) {
            shadowRoots.push(shadow);
            pending.push(shadow);
          }
          if ((++visited & 255) === 0 && performance.now() - sliceStart > WALK_SLICE_MS) {
            stats.busy += performance.now() - sliceStart;
            yield;
            sliceStart = performance.now();
          }
        }
      }
      stats.busy += performance.now() - sliceStart;
    };

    const isPlaying = (el) => !el.paused && !el.ended && el.readyState >= 2;
    const isAudible = (el) => !el.muted && el.volume > 0;

    // After an element played through to its end (e.g. looped), Gecko's
    // seamless-loop mode can feed a new captureStream() nothing.
    const hasWrapped = (el) => {
      const { duration, played } = el;
      return Number.isFinite(duration) && played.length > 0 && played.end(played.length - 1) >= duration - 0.05;
    };

    const startCapture = (port, sampleRate) => {
      let ctx = null;
      let mix = null;
      let processor = null;
      let sink = null;
      let stopped = false;
      let announced = false;
      let rescanTimer = null;
      const attached = new Map();
      const failed = new WeakSet();
      const roots = new Map();

      const audibleCount = () => {
        let n = 0;
        for (const el of attached.keys()) if (isPlaying(el) && isAudible(el)) n++;
        return n;
      };

      // Start streaming once something audible plays. Muted or volume-0 media
      // would only stream zeros from the page's (possibly busy) main thread;
      // the popup's own silence clock stands in for it until then.
      const announce = () => {
        if (announced || stopped || !ctx || ctx.state !== "running" || !audibleCount()) return;
        announced = true;
        processor.onaudioprocess = (event) => {
          if (stopped) return;
          const samples = new Float32Array(event.inputBuffer.getChannelData(0));
          try {
            port.postMessage({ type: "pcm", samples });
          } catch {
            stop();
          }
        };
        port.postMessage({ type: "started", sampleRate: ctx.sampleRate });
      };

      const ensureGraph = () => {
        if (ctx) return;
        try {
          ctx = new AudioContext({ sampleRate });
        } catch {
          ctx = new AudioContext();
        }
        mix = ctx.createGain();
        processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
        // The processor only runs while connected to the destination; route it
        // through a muted gain so it adds nothing to the page's output.
        sink = ctx.createGain();
        sink.gain.value = 0;
        mix.connect(processor);
        processor.connect(sink);
        sink.connect(ctx.destination);
        // Pages without user activation start with a suspended context; begin
        // streaming whenever it is allowed to run.
        ctx.addEventListener("statechange", announce);
        ctx.resume().catch(() => {});
      };

      // Re-seeking in place leaves Gecko's seamless-loop mode. It fires media
      // events the page can see, so only do it when a wrapped element's
      // capture really comes out digitally silent.
      const checkWrapped = (el, level) => {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        level.connect(analyser);
        setTimeout(() => {
          if (stopped || !attached.has(el)) return;
          const data = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(data);
          analyser.disconnect();
          if (isPlaying(el) && isAudible(el) && data.every((v) => v === 0)) {
            try {
              el.currentTime = el.currentTime;
            } catch {}
          }
        }, WRAP_CHECK_MS);
      };

      const attach = (el) => {
        if (stopped || attached.has(el) || failed.has(el) || !isPlaying(el)) return;
        let stream;
        try {
          stream = el.captureStream();
        } catch (err) {
          // e.g. EME-protected media; don't retry on every 'playing'.
          failed.add(el);
          console.warn("[shazam-firefox] captureStream failed:", err);
          return;
        }
        ensureGraph();
        const level = ctx.createGain();
        const syncLevel = () => {
          level.gain.value = el.muted ? 0 : el.volume;
          announce();
        };
        level.gain.value = el.muted ? 0 : el.volume;
        level.connect(mix);
        const sources = [];
        const addTrack = (track) => {
          if (track.kind !== "audio") {
            track.stop();
            return;
          }
          const source = ctx.createMediaStreamTrackSource(track);
          source.connect(level);
          sources.push(source);
        };
        // A new resource (next track, src swap, ad hand-over) ends the old
        // track and adds a new one to the same stream.
        const onAddTrack = (event) => addTrack(event.track);
        stream.getTracks().forEach(addTrack);
        stream.addEventListener("addtrack", onAddTrack);
        el.addEventListener("volumechange", syncLevel);
        attached.set(el, () => {
          el.removeEventListener("volumechange", syncLevel);
          stream.removeEventListener("addtrack", onAddTrack);
          for (const source of sources) source.disconnect();
          level.disconnect();
          for (const track of stream.getTracks()) track.stop();
        });
        if (hasWrapped(el)) checkWrapped(el, level);
        announce();
      };

      // Attaches what each slice of the walk finds; `done` gets the walk's
      // total busy time.
      const scan = (root, done) => {
        const media = [];
        const shadowRoots = [];
        const stats = { busy: 0 };
        const walk = collectMedia(root, media, shadowRoots, stats);
        const step = () => {
          if (stopped) return;
          const { done: finished } = walk.next();
          shadowRoots.splice(0).forEach(watch);
          media.splice(0).forEach(attach);
          if (!finished) setTimeout(step, 0);
          else if (done) done(stats.busy);
        };
        step();
      };

      // Media that starts later fires 'playing'; nodes and shadow roots added
      // later show up as mutations. Neither crosses shadow boundaries, so
      // watch every root.
      // Also announce: media resumed after a pause is attached already, and
      // would otherwise never start the stream.
      const onPlaying = (event) => {
        if (!(event.target instanceof HTMLMediaElement)) return;
        attach(event.target);
        announce();
      };
      const onMutations = (records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof Element) scan(node);
          }
        }
      };
      const watch = (root) => {
        if (roots.has(root)) return;
        const observer = new MutationObserver(onMutations);
        observer.observe(root, { childList: true, subtree: true });
        root.addEventListener("playing", onPlaying, true);
        roots.set(root, observer);
      };

      const scheduleRescan = () => {
        rescanTimer = setTimeout(() => {
          if (stopped) return;
          scan(document, (busy) => {
            if (busy <= SLOW_WALK_MS) scheduleRescan();
          });
        }, RESCAN_MS);
      };
      // The popup asks for a rescan while the tab is audible and nothing
      // streams: media in a shadow root attached to an existing element
      // raises no mutation.
      let rescanning = false;
      const onPortMessage = (msg) => {
        if (msg.type !== "rescan" || rescanning || stopped) return;
        rescanning = true;
        scan(document, () => {
          rescanning = false;
        });
      };

      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(rescanTimer);
        port.onDisconnect.removeListener(stop);
        port.onMessage.removeListener(onPortMessage);
        window.removeEventListener("pagehide", onPageHide);
        for (const [root, observer] of roots) {
          observer.disconnect();
          root.removeEventListener("playing", onPlaying, true);
        }
        roots.clear();
        for (const detach of attached.values()) detach();
        attached.clear();
        if (ctx) {
          processor.onaudioprocess = null;
          ctx.removeEventListener("statechange", announce);
          mix.disconnect();
          processor.disconnect();
          sink.disconnect();
          ctx.close().catch(() => {});
        }
      };
      // Unload, or a freeze into the back-forward cache: end the capture while
      // the document can still run code; the popup reconnects to the new one.
      const onPageHide = () => {
        stop();
        try {
          port.disconnect();
        } catch {}
      };
      port.onDisconnect.addListener(stop);
      port.onMessage.addListener(onPortMessage);
      window.addEventListener("pagehide", onPageHide);

      watch(document);
      scan(document, (busy) => {
        if (busy <= SLOW_WALK_MS) scheduleRescan();
        // Tells the popup whether to wait for this frame's audio before it
        // falls back to feeding silence.
        if (!stopped) port.postMessage({ type: "state", playing: audibleCount() });
      });
    };

    chrome.runtime.onConnect.addListener((port) => {
      const [name, rate] = port.name.split("@");
      if (name !== PORT_NAME) return;
      try {
        startCapture(port, Number(rate) || undefined);
      } catch (err) {
        console.warn("[shazam-firefox] capture failed:", err);
        try {
          port.disconnect();
        } catch {}
      }
    });

    window.__ffShazamCapture = true;
  }

  // Tells scripting.executeScript that this frame is reachable.
  return true;
})();
