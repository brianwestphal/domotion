import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";

const destination = process.argv[2];
if (destination == null) throw new Error("usage: record-boot-identity.mjs <output-file>");
let identity;
if (platform() === "linux") identity = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
else if (platform() === "darwin") identity = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
else if (platform() === "win32") identity = execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"], { encoding: "utf8" }).trim();
else throw new Error(`unsupported native scrollbar platform: ${platform()}`);
if (identity.length === 0) throw new Error("runner boot identity is empty");
writeFileSync(destination, `${identity}\n`);
