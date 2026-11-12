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

  function runUrl() {
    var mem = "";
    try {
      var raw = JSON.parse(localStorage.getItem("jb-mem-level") || "null");
      if (raw && isFinite(raw.level) && raw.level > 0 && raw.level <= 5)
        mem = "&mem=" + raw.level;
    } catch (e) {}
    // This must be a normal navigation from index.html. jb-g.js checks the
    // same-origin referrer before it will arm the kernel stage.
    return "launch.html?v=gh1402guard4&log=1&afterglow=run&mode=goldhen&cb=" + Date.now() + mem;
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

  function beginCountdown() {
    if (params.get("afterglow") === "done") {
      stop("GoldHEN payload thread started. Check the console notification; reboot before another attempt.");
      return;
    }

    if (params.get("afterglow") === "failed") {
      stop("GoldHEN did not start. Quit and relaunch the browser to try again.");
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
        "GoldHEN payload unverified on hardware. On a refusal just quit " +
        "and relaunch the browser -- the page reloads fresh.";
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
          (experimental ? "EXPERIMENTAL 14.02 -- " : "") +
          crashNotice +
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
      remaining = 5;
      beginCountdown();
    });
    return true;
  }

  /* If the last run died mid-primitive (out-of-memory kill: no JS ever
     ran again, so the attempt flag in localStorage is still set), step
     the heap profile down one level so the next run grooms less memory.
     Profiles live in core.js (?mem=1..5); level 0 is the heaviest. */
  var landingFirmware = detectedFirmware();
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
            "). Fully close the browser (Options) or restart the console, then reopen this page."
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
