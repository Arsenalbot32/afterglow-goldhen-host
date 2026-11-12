"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const code = fs.readFileSync(path.join(__dirname, "..", "site", "launch.js"), "utf8");

function load(userAgent) {
  const elements = new Map();
  const ticks = [];
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
  }, { filename: "launch.js" });
  return { window, element, ticks };
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

console.log("launch gate self-test passed");
