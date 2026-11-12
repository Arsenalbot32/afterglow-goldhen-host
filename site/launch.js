(function () {
  "use strict";

  var count = document.getElementById("count");
  var start = document.getElementById("start");
  var crashReport = document.getElementById("crash-report");
  var crashSummary = document.getElementById("crash-summary");
  var acknowledge = document.getElementById("ack-crash");
  var diagnosticTest = document.getElementById("diagnostic-test");
  var testStorage = document.getElementById("test-storage");
  var testResult = document.getElementById("test-result");
  var params = new URLSearchParams(window.location.search);
  var diagnostics = window.AfterglowBreadcrumb || null;
  var remaining = 5;
  var timer = null;
  var launched = false;
  var testBound = false;

  function detectedFirmware() {
    var match = (navigator.userAgent || "").match(/PlayStation\s+4[\/ ](\d+)\.(\d+)/);
    if (!match) return null;
    return match[1] + "." + parseInt(match[2], 16).toString(16).padStart(2, "0");
  }

  function stop(message) {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    if (count) count.textContent = message;
    if (start) start.style.display = "none";
  }

  var MEM_LABELS = [
    "mem0 heaviest",
    "mem1 balanced",
    "mem2 low",
    "mem3 very low",
    "mem4 minimum",
    "mem5 extreme",
  ];

  function storedMem() {
    try {
      var raw = JSON.parse(localStorage.getItem("jb-mem-level") || "null");
      if (raw && isFinite(raw.level) && raw.level >= 0 && raw.level <= 5)
        return raw;
    } catch (e) {}
    return null;
  }

  /* Effective groom level for the next run. An explicit mem=0 (the
     heaviest groom, ~130 MB) is honoured on 14.02 again: the November 11
     hardware run that reached the GoldHEN payload used exactly that
     groom, and the 4.4M/8.6M addrof draws only ever appeared under the
     light profiles. If mem=0 runs the browser out of memory, the crash
     ladder below steps down to mem=2 automatically, so the downside is
     one recovered cycle, not a dead end. Without an explicit choice,
     14.02 still starts on the light default (mem=2). */
  function effectiveMemLevel() {
    var raw = storedMem();
    var level = raw ? raw.level : 0;
    if ((!raw || !raw.explicit) && level === 0 &&
        detectedFirmware() === "14.02") level = 2;
    /* An automatic retry after a live-page give-up rotates the groom
       profile: the addrof coverage draw is a function of the groom
       geometry, and a console whose draw is pathologically stable under
       one profile (observed: minSlots 4.4M/8.6M under mem=2 on every
       run) only escapes by changing it. Retry 1 -> mem3, 2 -> mem1,
       3 -> mem4. */
    var rotated = autoRetryMemLevel();
    if (rotated !== null) level = rotated;
    return level;
  }

  /* The give-up path on the run page counts its self-reloads in
     sessionStorage ("jb-g-fail-reload"); each of those reloads relaunches
     through here, and each gets a different groom geometry. */
  function autoRetryMemLevel() {
    var n = 0;
    try {
      n = parseInt(sessionStorage.getItem("jb-g-fail-reload") || "0", 10);
    } catch (e) {}
    if (!isFinite(n) || n <= 0) return null;
    var seq = { 1: 3, 2: 1, 3: 4 };
    return seq[n] !== undefined ? seq[n] : null;
  }

  function runUrl() {
    var level = effectiveMemLevel();
    var mem = level > 0 ? "&mem=" + level : "";
    // This must be a normal navigation from index.html. jb-g.js checks the
    // same-origin referrer before it will arm the kernel stage.
    return "launch.html?v=gh1402ps2&log=1&afterglow=run&mode=goldhen&cb=" + Date.now() + mem;
  }

  function launchGoldHEN() {
    if (launched) return;
    var firmware = detectedFirmware() || "unknown";
    if (firmware !== "14.00" && firmware !== "14.02") {
      stop("Firmware " + firmware + " is not supported by this release.");
      return;
    }
    launched = true;
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    if (start) start.disabled = true;
    if (count) count.textContent = "Starting GoldHEN...";

    window.location.href = runUrl();
  }

  function enableStorageTest(firmware) {
    if (!diagnosticTest || !testStorage || !testResult || !diagnostics) return;
    diagnosticTest.hidden = false;
    if (testBound) return;
    testBound = true;
    testStorage.addEventListener("click", function () {
      var opened = diagnostics.begin(firmware || "unknown", "harmless storage test");
      var armed = opened && diagnostics.checkpoint(
        "storage-test-armed",
        "storage only; no WebKit exploit or kernel code",
      );
      if (!armed) {
        testResult.textContent = "FAILED: " + diagnostics.error() + ". No kernel code was run.";
        return;
      }
      testStorage.disabled = true;
      testResult.textContent =
        "PASS: marker " + armed.stage + " was written and read back. Refresh or reopen this page to prove it survived.";
    });
  }

  /* Heap-groom selector. placement-throw misses are a heap-lottery, and the
     geometry depends on the groom sizes, so a console that keeps missing on
     the default profile can try another. One button cycles auto -> 0..5 ->
     auto; the choice is stored explicit and honoured by runUrl() above. */
  function initMemSelector() {
    var btn = document.getElementById("mem-cycle");
    if (!btn) return;
    var note = document.getElementById("mem-note");

    function refresh() {
      var raw = storedMem();
      var explicit = raw && raw.explicit;
      var level = effectiveMemLevel();
      btn.textContent = explicit
        ? "Heap groom: " + MEM_LABELS[raw.level] + " (chosen)"
        : "Heap groom: auto";
      if (note) {
        if (autoRetryMemLevel() !== null) {
          note.textContent =
            "Auto-retry rotation: the next run uses a different groom " +
            "profile (the addrof draw depends on the groom geometry).";
        } else if (explicit && raw.level === 0 && detectedFirmware() === "14.02") {
          note.textContent =
            "mem=0 is the heaviest groom (~130 MB) -- the one the November 11 " +
            "run that reached the payload used. If the browser runs out of " +
            "memory, the site steps down to mem=2 automatically and relaunches.";
        } else {
          note.textContent = explicit
            ? "Next run uses ?mem=" + level + ". Cycle back to auto for the defaults."
            : "Auto: heaviest on 14.00, light on 14.02, lighter after memory crashes.";
        }
      }
    }

    btn.addEventListener("click", function () {
      var raw = storedMem();
      var current = raw && raw.explicit ? raw.level : -1;
      var next = current >= 5 ? -1 : current + 1;
      try {
        if (next < 0) localStorage.removeItem("jb-mem-level");
        else {
          localStorage.setItem(
            "jb-mem-level",
            JSON.stringify({ level: next, explicit: true, ts: Date.now() }),
          );
        }
      } catch (e) {}
      refresh();
    });

    refresh();
  }

  function beginCountdown() {
    var preNotice = "";

    if (params.get("afterglow") === "done") {
      stop("GoldHEN payload thread started. Check the console notification; reboot before another attempt.");
      return;
    }

    if (params.get("afterglow") === "failed") {
      /* The previous run armed the kernel stage and did not finish, so it
         left live kernel-side handles and deferred device destroys
         behind. Neither an in-session retry (the kernel can hang on the
         residue mid-run) nor closing the browser over them is safe, so
         the page stops: the recovery is a fresh browser process, and a
         console power cycle whenever anything freezes. */
      stop(
        "GoldHEN did not start. Close and reopen the browser to try again. " +
          "If the browser or the console freezes, power-cycle the console " +
          "(off 30 seconds) and try again.",
      );
      return;
    }

    if (params.get("afterglow") === "probe") {
      stop("Probe finished. No GoldHEN payload was started.");
      return;
    }

    var firmware = detectedFirmware();
    if (firmware && firmware !== "14.00" && firmware !== "14.02") {
      stop("Firmware " + firmware + " is not supported by this release.");
      return;
    }

    var experimental = firmware === "14.02";
    if (experimental) {
      enableStorageTest(firmware);
      if (count) count.textContent =
        "EXPERIMENTAL 14.02 route: kernel chain proven on a retail dump, " +
        "GoldHEN payload unverified on hardware. After a failed run, " +
        "close and reopen the browser; if anything freezes, power-cycle " +
        "the console.";
    }

    if (start) {
      start.style.display = "inline-block";
      start.addEventListener("click", launchGoldHEN);
    }

    timer = window.setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        launchGoldHEN();
        return;
      }
      if (count) {
        count.textContent =
          preNotice +
          (experimental ? "EXPERIMENTAL 14.02 -- " : "") +
          "GoldHEN starts in " + remaining +
          (remaining === 1 ? " second..." : " seconds...");
      }
    }, 1000);
  }

  function holdForPreviousRun(record) {
    if (!crashReport || !crashSummary || !acknowledge || !diagnostics) return false;
    crashReport.hidden = false;
    crashSummary.textContent = diagnostics.describe(record);
    if (diagnostics.isAcknowledged(record)) {
  crashReport.hidden = true;
  acknowledge.style.display = "none";
  return false;
}
    if (start) start.style.display = "none";
    if (count) count.textContent = "Auto-start paused until the previous run is acknowledged.";
    acknowledge.addEventListener("click", function () {
      if (!diagnostics.acknowledge(record)) {
        if (count) count.textContent =
          "Could not save acknowledgement (" + diagnostics.error() + "). Auto-start remains paused.";
        return;
      }
      crashReport.hidden = true;
      acknowledge.style.display = "none";
      acknowledge.disabled = true;
      acknowledge.textContent = "Previous run acknowledged";
      /* An in-session retry can hang the kernel on the previous run's
         residue mid-run, and closing the browser over the live handles
         can hang the process exit -- so the ack explains the recovery
         instead of retrying here. */
      stop(
        "Close and reopen the browser, then reopen this page to try again. " +
          "If the browser or the console freezes, power-cycle the console " +
          "(off 30 seconds) and try again.",
      );
    });
    return true;
  }

  /* If the last run died mid-primitive (out-of-memory kill: no JS ever
     ran again, so the attempt flag in localStorage is still set), step
     the heap profile down one level so the next run grooms less memory.
     Profiles live in core.js (?mem=1..5); level 0 is the heaviest. */
  var landingFirmware = detectedFirmware();
  initMemSelector();
  if (landingFirmware === "14.02") {
    if (!diagnostics) {
      stop("Persistent diagnostics did not load. No kernel stage will run.");
      return;
    }
    var previous = diagnostics.latest();
    /* Hold for an acknowledgement only when the last run reached the kernel
       stage (breadcrumb "kernel-armed"); a crash before that -- an
       out-of-memory kill in the WebKit primitive, say -- touched nothing,
       so the countdown just starts and the run re-arms itself. */
    var reachedKernel =
      previous && !diagnostics.isComplete(previous) &&
      previous.stage === "kernel-armed";
    if (reachedKernel && holdForPreviousRun(previous)) return;
  }

  /* The last run was killed by an out-of-memory dialog (attempt flag still
     set in localStorage, or its cookie twin).  Step the heap profile down
     two levels and go STRAIGHT to the run page -- no countdown, no extra
     click -- because nothing was written before the kill.  Gives up after
     six kills: then even the lightest groom does not fit and the browser
     itself needs a full close (Options button) or the console a restart. */
  var escalateScheduled = (function escalateAfterCrash() {
    try {
      var attempt = null;
      try { attempt = localStorage.getItem("jb-primitive-attempt"); } catch (e) {}
      if (!attempt) {
        try {
          var m = /(?:^|;\s*)jbpa=(\d)/.exec(document.cookie || "");
          if (m) attempt = m[1];
        } catch (e) {}
      }
      if (!attempt) return false;
      var raw = null;
      try { raw = JSON.parse(localStorage.getItem("jb-mem-level") || "null"); } catch (e) {}
      var level = raw && isFinite(raw.level) && raw.level >= 0 && raw.level <= 5 ? raw.level : 0;
      var crashes = raw && isFinite(raw.crashes) ? raw.crashes : 0;
      if (Date.now() - (raw && raw.ts || 0) > 30 * 60 * 1000) { level = 0; crashes = 0; }
      /* escalate from the level that actually ran: 14.02 defaults to 2
         even when nothing is stored yet */
      if (level === 0 && detectedFirmware() === "14.02") level = 2;
      var next = Math.min(level + 2, 5);
      crashes += 1;
      try {
        localStorage.setItem("jb-mem-level", JSON.stringify({ level: next, ts: Date.now(), crashes: crashes }));
        localStorage.removeItem("jb-primitive-attempt");
      } catch (e) {}
      try { document.cookie = "jbpa=; path=/; max-age=0"; } catch (e) {}
      launched = true;
      if (timer !== null) window.clearInterval(timer);
      if (start) { start.style.display = "none"; start.disabled = true; }
      if (count) count.textContent =
        crashes > 6
          ? "Out of memory even on the lightest profile (crash " + crashes +
            "). Close every other browser tab (Options button), fully quit the " +
            "browser or restart the console, then reopen this page."
          : "Previous run ran out of memory -- retrying directly with the lighter heap profile mem=" + next + "...";
      if (crashes > 6) return false;
      window.setTimeout(function () {
        try { window.location.href = runUrl(); } catch (e) {}
      }, 1500);
      return true;
    } catch (e) {
      return false;
    }
  })();

  if (!escalateScheduled) beginCountdown();
})();
