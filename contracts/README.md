# Contracts

| Contract | Network | Purpose |
|---|---|---|
| `RecoveryRegistry` | HSK Chain testnet (133) | Recovery cases, repayment reservations under per-case consent or a seller's standing policy, the exposure ledger, and each case's single outcome |
| `SettleBackDeploymentMarker` | HSK Chain mainnet (177) | An immutable pointer to the registry deployment on 133: source commit, registry chain and address, deployer, time |

The registry goes to mainnet only after a security review. Neither contract holds funds.

## Tests

```bash
forge test                 # unit, fuzz, and invariant tests
forge test --mc Invariant  # invariant suite only (about a minute)
```

## Deployment

Keys are used from Foundry's encrypted keystore, never as command-line arguments. The deployer pays gas and has no authority over either contract. The verifier is a separate key, fixed in the registry for its lifetime.

```bash
# One-time: import the deployer key and create the verifier key (both prompt for a password).
cast wallet import settleback-deployer --interactive
cast wallet new ~/.foundry/keystores settleback-verifier

# Registry on 133. The script refuses any other chain and a verifier equal to the deployer.
SETTLEBACK_VERIFIER=<verifier address> \
forge script script/DeployRegistry.s.sol:DeployRegistry \
  --rpc-url https://testnet.hsk.xyz --account settleback-deployer --sender <deployer address> --broadcast

# Marker on 177. Before broadcasting, the script reads the registry on 133 and refuses an address
# without the registry's code or with a different verifier.
COMMIT_SHA=$(git rev-parse HEAD) REGISTRY_ADDRESS=<registry address> SETTLEBACK_VERIFIER=<verifier address> \
forge script script/DeployMarker.s.sol:DeployMarker \
  --rpc-url https://mainnet.hsk.xyz --account settleback-deployer --sender <deployer address> --broadcast
```

Source verification uses Sourcify on both networks, and Blockscout on mainnet:

```bash
forge verify-contract <registry address> src/RecoveryRegistry.sol:RecoveryRegistry --chain 133 \
  --verifier sourcify --constructor-args $(cast abi-encode "constructor(address)" <verifier address>) --watch

forge verify-contract <marker address> src/SettleBackDeploymentMarker.sol:SettleBackDeploymentMarker --chain 177 \
  --verifier blockscout --verifier-url https://hsk.blockscout.com/api/ \
  --constructor-args $(cast abi-encode "constructor(bytes32,uint256,address)" <padded commit> 133 <registry address>) --watch
```

Compiler settings are pinned in `foundry.toml`: solc 0.8.37, optimizer 200 runs, EVM version `cancun`, no metadata hash.
