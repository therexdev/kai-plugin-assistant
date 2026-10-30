"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
if (process.platform !== "win32") {
  if (process.argv.includes("--if-windows")) process.exit(0);
  throw new Error("Build the Windows voice helper on Windows.");
}
const framework = path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319");
const programFiles = process.env["ProgramFiles(x86)"];
const union = path.join(programFiles, "Windows Kits/10/UnionMetadata");
const version = fs.readdirSync(union).filter(v => /^\d/.test(v) && fs.existsSync(path.join(union, v, "Windows.winmd"))).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
if (!version) throw new Error("The Windows SDK metadata is required to compile the local voice helper.");
const referenceRoot = path.join(programFiles, "Reference Assemblies/Microsoft/Framework/.NETFramework/v4.8");
const facades = path.join(referenceRoot, "Facades");
const references = [path.join(union, version, "Windows.winmd"), path.join(framework, "System.Runtime.WindowsRuntime.dll"),
  ...["System.dll", "System.Core.dll", "System.Speech.dll", "System.Web.Extensions.dll"].map(f => path.join(referenceRoot, f)), ...fs.readdirSync(facades).filter(f => f.endsWith(".dll")).map(f => path.join(facades, f))];
const output = path.resolve(".build/windows-helpers/kai-windows-voice.exe"); fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(path.join(framework, "csc.exe"), ["/nologo", "/noconfig", "/target:exe", "/platform:x64", "/optimize+", "/out:" + output,
  ...references.map(r => "/reference:" + r), path.resolve("native/windows/voice.cs")], { stdio: "inherit", windowsHide: true });
console.log("Built local Windows voice helper:", output);
