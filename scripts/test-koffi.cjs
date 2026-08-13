// koffi/COM 冒烟测试：验证目录选择器依赖的 FFI 链路在指定 Node 运行时下可用。
// 不调用 Show，不弹窗。用法：node scripts/test-koffi.cjs
const koffi = require('koffi').default;

function guidBytes(text) {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text);
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(m[1], 16), 0);
  bytes.writeUInt16LE(parseInt(m[2], 16), 4);
  bytes.writeUInt16LE(parseInt(m[3], 16), 6);
  Buffer.from(m[4] + m[5], 'hex').copy(bytes, 8);
  return bytes;
}

try {
  const ole32 = koffi.load('ole32.dll');
  const coInit = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32']);
  const coUninit = ole32.func('__stdcall', 'CoUninitialize', 'void', []);
  const coCreate = ole32.func('__stdcall', 'CoCreateInstance', 'int32', ['void *', 'void *', 'uint32', 'void *', 'void *']);
  const CLSID_FILE_OPEN_DIALOG = guidBytes('dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7');
  const IID_IFILE_OPEN_DIALOG = guidBytes('d57c7288-d4ad-4768-be02-9d969532d960');
  const ptrSize = koffi.sizeof('void *');

  const hrInit = coInit(null, 2);
  console.log(`CoInitializeEx: 0x${(hrInit >>> 0).toString(16)}`);
  if (hrInit < 0) throw new Error(`CoInitializeEx failed: ${hrInit}`);

  const out = Buffer.alloc(ptrSize);
  const hrCreate = coCreate(CLSID_FILE_OPEN_DIALOG, null, 1, IID_IFILE_OPEN_DIALOG, out);
  console.log(`CoCreateInstance(FileOpenDialog): 0x${(hrCreate >>> 0).toString(16)}`);
  if (hrCreate < 0) throw new Error(`CoCreateInstance failed: ${hrCreate}`);

  const dialog = koffi.decode(out, 'void *');
  const vtable = koffi.decode(dialog, 'void *');
  const protoRelease = koffi.proto('uint32 __stdcall DshComRelease(void *self)');
  const fnRelease = koffi.decode(vtable, 2 * ptrSize, 'void *');
  const released = koffi.call(fnRelease, protoRelease, dialog);
  console.log(`Release: ${released}`);
  coUninit();
  console.log('KOFFI OK —— 目录选择器 FFI 链路正常');
} catch (err) {
  console.error('KOFFI FAIL:', err.message);
  process.exit(1);
}
