"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
if (process.platform !== "win32") {
  if (process.argv.includes("--if-windows")) process.exit(0);
  throw new Error("Build the desktop helper on Windows.");
}
const framework = path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319");
const refs = path.join(process.env["ProgramFiles(x86)"], "Reference Assemblies/Microsoft/Framework/.NETFramework/v4.8");
const output = path.resolve(".build/windows-helpers/kai-computer.exe"); fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(path.join(framework, "csc.exe"), ["/nologo", "/noconfig", "/target:exe", "/platform:x64", "/optimize+", "/out:" + output,
  ...["System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll", "System.Web.Extensions.dll", "WindowsBase.dll", "UIAutomationClient.dll", "UIAutomationTypes.dll"].map(f => "/reference:" + path.join(refs, f)),
  path.resolve("native/windows/computer.cs")], { stdio: "inherit", windowsHide: true });
console.log("Built private desktop helper:", output);
