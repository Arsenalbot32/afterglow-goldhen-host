"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const code = fs.readFileSync(path.join(__dirname, "..", "site", "launch.js"), "utf8");

function load(userAgent) {
  const elements = new Map();
  const ticks = [];
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        hidden: true,
        style: {},
        textContent: "",
        disabled: false,
        listeners: {},
        addEventListener(event, callback) { this.listeners[event] = callback; },
      });
    }
    return elements.get(id);
  }
  const window = {
    location: { search: "", href: "" },
    AfterglowBreadcrumb: {
      latest: () => null,
      begin: () => { throw new Error("blocked firmware started a run"); },
    },
    setInterval: callback => { ticks.push(callback); return ticks.length; },
    clearInterval: () => {},
  };
  vm.runInNewContext(code, {
    window,
    document: { getElementById: element },
    navigator: { userAgent },
    URLSearchParams,
    localStorage,
    Date,
  }, { filename: "launch.js" });
  return { window, element, ticks, store };
}

/* 14.02 is ENABLED again, behind an EXPERIMENTAL warning: the kernel chain
   is proven on a retail dump and the guarded bootstrap refuses safely, so
   the button must exist and the countdown must run. */
const experimental = load("Mozilla/5.0 (PlayStation 4 14.02)");
assert.notEqual(experimental.element("start").style.display, "none");
assert.equal(typeof experimental.element("start").listeners.click, "function");
assert.equal(experimental.ticks.length, 1);
assert.match(experimental.element("count").textContent, /EXPERIMENTAL 14\.02/);
assert.equal(typeof experimental.element("test-storage").listeners.click, "function");
experimental.element("start").listeners.click();
assert.match(experimental.window.location.href, /^launch\.html\?/);

const supported = load("Mozilla/5.0 (PlayStation 4 14.00)");
assert.equal(typeof supported.element("start").listeners.click, "function");
supported.element("start").listeners.click();
assert.match(supported.window.location.href, /^launch\.html\?/);

const unknown = load("Mozilla/5.0");
assert.equal(unknown.ticks.length, 1);
unknown.element("start").listeners.click();
assert.equal(unknown.window.location.href, "");
assert.match(unknown.element("count").textContent, /not supported/);

/* Heap-groom selector: a console that keeps missing placement on the
   default profile needs a way to try another geometry from the landing
   page (editing the URL by hand would break the referrer guard). The
   button cycles auto -> 0..5 -> auto, an explicit choice is honoured by
   runUrl() even on 14.02 (which otherwise forces the light default),
   and the crash-ladder's non-explicit records keep working. */
{
  const page = load("Mozilla/5.0 (PlayStation 4 14.02)");
  const btn = page.element("mem-cycle");

  assert.match(btn.textContent, /auto/);
  assert.doesNotMatch(page.window.location.href, /&mem=/); // not launched yet

  // Default on 14.02 is still the light groom (mem=2).
  page.element("start").listeners.click();
  assert.match(page.window.location.href, /&mem=2/);

  // Cycle: auto -> 0 -> 1.
  btn.listeners.click();
  assert.match(btn.textContent, /mem0 heaviest/);
  assert.equal(
    JSON.parse(page.store.get("jb-mem-level")).explicit, true);

  // An explicit mem=0 is never run on 14.02: the heaviest groom
  // out-of-memory-crashes the browser on the experimental route, so
  // runUrl() converts it to the light groom (mem=2) and the selector
  // note explains the conversion.
  const chosen = load("Mozilla/5.0 (PlayStation 4 14.02)");
  chosen.element("mem-cycle").listeners.click(); // auto -> 0 (stored explicit)
  assert.match(chosen.element("mem-cycle").textContent, /mem0 heaviest/);
  assert.match(chosen.element("mem-note").textContent, /crashes the browser on 14\.02/);
  chosen.element("start").listeners.click();
  assert.match(chosen.window.location.href, /&mem=2/);

  // Cycling from a stored 0 still goes to 1 and is honoured as-is.
  const cycled = load("Mozilla/5.0 (PlayStation 4 14.02)");
  cycled.store.set("jb-mem-level", JSON.stringify({ level: 0, explicit: true }));
  cycled.element("mem-cycle").listeners.click(); // 0 -> 1
  assert.match(cycled.element("mem-cycle").textContent, /mem1 balanced/);
  cycled.element("start").listeners.click();
  assert.match(cycled.window.location.href, /&mem=1/);

  // 14.00 is unchanged: an explicit mem=0 is honoured as-is.
  const legacy = load("Mozilla/5.0 (PlayStation 4 14.00)");
  legacy.store.set("jb-mem-level", JSON.stringify({ level: 0, explicit: true }));
  legacy.element("start").listeners.click();
  assert.doesNotMatch(legacy.window.location.href, /&mem=/);

  // The crash ladder's non-explicit record is still honoured as-is.
  const ladder = load("Mozilla/5.0 (PlayStation 4 14.02)");
  ladder.store.set("jb-mem-level", JSON.stringify({ level: 3, ts: Date.now(), crashes: 1 }));
  ladder.element("start").listeners.click();
  assert.match(ladder.window.location.href, /&mem=3/);

  // Cycling past mem5 returns to auto and clears the stored record.
  const wrap = load("Mozilla/5.0 (PlayStation 4 14.02)");
  wrap.store.set("jb-mem-level", JSON.stringify({ level: 5, explicit: true }));
  wrap.element("mem-cycle").listeners.click();
  assert.match(wrap.element("mem-cycle").textContent, /auto/);
  assert.equal(wrap.store.has("jb-mem-level"), false);
}

console.log("launch gate self-test passed");
