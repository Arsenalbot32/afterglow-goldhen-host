"use strict";

const assert = require("node:assert/strict");
const verify = require("../site/teardown-verify-1402.js");

function q(low, hi) { return { low: low >>> 0, hi: hi >>> 0 }; }
function add(address, offset) { return q((address.low + offset) >>> 0, address.hi); }
function key(address) { return address.hi.toString(16) + ":" + address.low.toString(16); }
function qbytes(pointer) {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, pointer.low, true);
  view.setUint32(4, pointer.hi, true);
  return out;
}
function fromBytes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return q(view.getUint32(0, true), view.getUint32(4, true));
}

function fixture() {
  const memory = new Map();
  const ofs = q(0x1000, 0xffff1000);
  const stub = q(0xb3a400, 0xffffffff);
  const dtab = q(0xb3a410, 0xffffffff);
  const qtab = q(0xb3a470, 0xffffffff);
  const devSource = q(0x2000, 0xffffffff);
  const queueSource = q(0x3000, 0xffffffff);
  const deviceBytes = Uint8Array.from({ length: verify.TABLE_LENGTH }, (_, i) => i + 1);
  const queueBytes = Uint8Array.from({ length: verify.TABLE_LENGTH }, (_, i) => 200 - i);
  const files = { 10: q(0x5000, 0xffff1000), 11: q(0x6000, 0xffff1000),
    12: q(0x7000, 0xffff1000) };
  const kq = q(0x8000, 0xffff1000);

  function set(address, bytes) { memory.set(key(address), Uint8Array.from(bytes)); }
  function setq(address, value) { set(address, qbytes(value)); }
  set(stub, [0x31, 0xc0, 0xc3, 0, 0, 0, 0, 0]);
  set(devSource, deviceBytes);
  set(queueSource, queueBytes);
  set(dtab, verify.expectedTable(deviceBytes, stub));
  set(qtab, verify.expectedTable(queueBytes, stub));
  for (const [fd, address] of Object.entries(files)) setq(add(ofs, Number(fd) * 8), address);
  setq(add(files[10], 8), dtab);
  setq(add(files[11], 8), dtab);
  setq(add(files[12], 8), qtab);
  setq(files[12], kq);
  setq(add(kq, 0xa0), q(3, 0));

  const input = {
    read(address, length) {
      const bytes = memory.get(key(address));
      return bytes && bytes.length === length ? bytes.slice() : null;
    },
    read8(address) {
      const bytes = memory.get(key(address));
      return bytes && bytes.length === 8 ? fromBytes(bytes) : null;
    },
    plus: add,
    inHeap: pointer => pointer.hi === 0xffff1000 && pointer.low !== 0,
    ofs, stub, dtab, qtab,
    deviceSource: { address: devSource, bytes: deviceBytes.slice() },
    queueSource: { address: queueSource, bytes: queueBytes.slice() },
    devs: [10, 11], queues: [12],
    noteBefore: { 12: q(3, 6) },
  };
  return { input, memory, set, setq, files, kq, dtab, qtab, stub };
}

let f = fixture();
let result = verify.verify(f.input);
assert.equal(result.ok, true, result.failures.join("; "));
assert.deepEqual(result.checked, { devices: 2, queues: 1, notes: 1, tables: 2 });

f = fixture();
f.set(f.dtab, new Uint8Array(verify.TABLE_LENGTH));
result = verify.verify(f.input);
assert.equal(result.ok, false);
assert.ok(result.failures.some(x => /device table: clone mismatch/.test(x)));

f = fixture();
f.setq(add(f.files[11], 8), q(0x2000, 0xffffffff));
result = verify.verify(f.input);
assert.equal(result.ok, false);
assert.ok(result.failures.some(x => /device fd 11: f_ops not cloned/.test(x)));

f = fixture();
f.setq(add(f.files[12], 8), f.dtab);
result = verify.verify(f.input);
assert.equal(result.ok, false);
assert.ok(result.failures.some(x => /queue fd 12: f_ops not cloned/.test(x)));

f = fixture();
f.setq(add(f.kq, 0xa0), q(3, 1));
result = verify.verify(f.input);
assert.equal(result.ok, false);
assert.ok(result.failures.some(x => /note list not neutralized/.test(x)));

f = fixture();
f.setq(add(f.kq, 0xa0), q(4, 0));
result = verify.verify(f.input);
assert.equal(result.ok, false);
assert.ok(result.failures.some(x => /note list not neutralized/.test(x)));

f = fixture();
f.input.noteBefore = {};
result = verify.verify(f.input);
assert.equal(result.ok, false);
assert.ok(result.failures.some(x => /missing note preimage/.test(x)));

f = fixture();
f.input.devs.push(-1);
result = verify.verify(f.input);
assert.equal(result.ok, false);
assert.ok(result.failures.some(x => /invalid/.test(x)));

f = fixture();
f.input.queues.push(10);
result = verify.verify(f.input);
assert.equal(result.ok, false);
assert.ok(result.failures.some(x => /queue fd 10: duplicate/.test(x)));

f = fixture();
f.set(f.stub, [0x31, 0xc0, 0xc3, 0, 0xff, 0, 0, 0]);
result = verify.verify(f.input);
assert.equal(result.ok, false);
assert.ok(result.failures.some(x => /close stub: unexpected bytes/.test(x)));

console.log("teardown verifier self-test passed");
