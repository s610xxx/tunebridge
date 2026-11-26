import { sign } from "../site/functions/eapi.ts";

// 真值来自本机 jshell 直接调用生产 Java 代码：
//   com.tunebridge.provider.netease.NeteaseEapi.sign(apiPath, paramsJson)
// 长度：224 / 192 / 224 个十六进制字符。
const CASES = [
  ["/api/cloudsearch/pc", '{"s":"泡沫 G.E.M.","type":1}',
    "2B5D64177AA6460FBAA3DCB1285E28954BBB4F7556E09B0FB25750F12398BB50BA1206B0ECF3E83359CCD06F691C91D6A3D18E6DF442137F4A8B9203033FB5FDBAC9F2D38F3FC188F3CA2F48FFF0D521BB2849CC29AF1979E6D345B0035C09F7E320E84A8A46D49449DEBD5048DF713E"],
  ["/api/playlist/create", "{}",
    "F835BDC20C03A1ED859BF020B01BC98DD690D10EA172F44824CCC6900010E4BD758F07E2B713C15227B2F154D140B46B7F811E03D5F0BF23E20D6671EF42CE6C689850C66B42817043E618931D35243B6AA3B102FBE7296AB0DB9EA5C46AD12B"],
  ["/api/v6/playlist/detail", '{"id":"18636602414"}',
    "9E44C61C7604F33F328DE9633B8B0E69E14D621EB896C63E8E0FBC1DFA867E56394D1A9D30E79E50DA6BF44BAB76337EBEAA283D88A505CD6295635B8E9DFABF6059556A2D94DDF6AAF4C5491B1C33C1891A154DF6C6F90448E918DF42FC8DD0B6097971C1A81F69A4E72416461CC186"],
];

let failed = 0;
for (const [path, json, expected] of CASES) {
  const actual = await sign(path, json);
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${path}  (java len=${expected.length} ts len=${actual.length})`);
  if (!ok) {
    failed++;
    const at = [...expected].findIndex((ch, i) => ch !== actual[i]);
    console.log(`  首个差异在 ${at}`);
    console.log(`  java: ${expected.slice(Math.max(0, at - 8), at + 16)}`);
    console.log(`  ts  : ${actual.slice(Math.max(0, at - 8), at + 16)}`);
  }
}
console.log(failed === 0 ? "ALL VECTORS MATCH JAVA BYTE-FOR-BYTE" : `${failed} MISMATCH`);
process.exit(failed === 0 ? 0 : 1);
