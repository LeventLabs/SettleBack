// Creates the four keys `npm run demo:testnet` reads, in a directory only the current user can read,
// and prints the addresses to fund. Existing keys are kept, never overwritten.
// Usage, from the repository root: npm run demo:keys
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const ROLES = ["verifier", "buyer", "seller", "operator"] as const;
const dir = (process.env.SETTLEBACK_DEMO_KEYS ?? `${homedir()}/.config/settleback/testnet-demo`).replace(/^~(?=\/)/, homedir());

mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const lines: string[] = [];
for (const role of ROLES) {
  const file = `${dir}/${role}.key`;
  let key: string;
  let note: string;
  if (existsSync(file)) {
    key = readFileSync(file, "utf8").trim();
    // Never echo the value.
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      console.error(`${file} exists but does not hold 0x followed by 64 hex digits; fix or remove it, then rerun.`);
      process.exit(1);
    }
    chmodSync(file, 0o600);
    note = "kept";
  } else {
    key = generatePrivateKey();
    writeFileSync(file, `${key}\n`, { mode: 0o600, flag: "wx" });
    note = "created";
  }
  lines.push(`  ${role.padEnd(9)} ${privateKeyToAccount(key as Hex).address}  ${note}`);
}

console.log(
  [
    `Demo keys in ${dir} (readable only by you; test keys, never for real funds):`,
    ...lines,
    "",
    "Next:",
    "  1. Fund the verifier and the seller with testnet HSK: https://hskchain.net/faucet",
    "  2. Deploy your own demo registry with the verifier above (contracts/README.md, from contracts/):",
    "       SETTLEBACK_VERIFIER=<verifier address> forge script script/DeployRegistry.s.sol:DeployRegistry \\",
    "         --rpc-url https://testnet.hsk.xyz --account <deployer keystore> --sender <deployer address> --broadcast",
    "  3. Put the registry address in .env as SETTLEBACK_DEMO_REGISTRY_ADDRESS, then: npm run demo:testnet",
  ].join("\n"),
);
