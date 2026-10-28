// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {RecoveryRegistry} from "../src/RecoveryRegistry.sol";
import {SettleBackDeploymentMarker} from "../src/SettleBackDeploymentMarker.sol";

/// @notice Deploys the deployment marker to HSK Chain mainnet (177), pointing at the registry on
///         testnet (133). Before broadcasting it reads the registry on 133 and refuses to point at
///         an address without the registry's code or with a different verifier.
///
///   COMMIT_SHA=$(git rev-parse HEAD) REGISTRY_ADDRESS=0x... SETTLEBACK_VERIFIER=0x... \
///   forge script script/DeployMarker.s.sol:DeployMarker \
///     --rpc-url https://mainnet.hsk.xyz --account <keystore> --sender <deployer> --broadcast
contract DeployMarker is Script {
    uint256 internal constant HSK_MAINNET = 177;
    uint256 internal constant HSK_TESTNET = 133;

    function run() external returns (SettleBackDeploymentMarker marker) {
        require(block.chainid == HSK_MAINNET, "DeployMarker: only HSK Chain mainnet (177)");
        bytes32 commit = paddedCommit(vm.envString("COMMIT_SHA"));
        address registry = vm.envAddress("REGISTRY_ADDRESS");
        address verifier = vm.envAddress("SETTLEBACK_VERIFIER");
        string memory registryRpc = vm.envOr("REGISTRY_RPC_URL", string("https://testnet.hsk.xyz"));

        uint256 mainnet = vm.activeFork();
        vm.selectFork(vm.createFork(registryRpc));
        require(block.chainid == HSK_TESTNET, "DeployMarker: REGISTRY_RPC_URL is not HSK Chain testnet");
        require(registry.code.length > 0, "DeployMarker: no contract at REGISTRY_ADDRESS on 133");
        // The verifier is an immutable embedded in the runtime code, so compare against a reference
        // instance built here with the same verifier; it is not broadcast.
        address expected = address(new RecoveryRegistry(verifier));
        require(keccak256(registry.code) == keccak256(expected.code), "DeployMarker: code at REGISTRY_ADDRESS is not this RecoveryRegistry");
        require(RecoveryRegistry(registry).verifier() == verifier, "DeployMarker: registry verifier differs");
        vm.selectFork(mainnet);

        vm.startBroadcast();
        marker = new SettleBackDeploymentMarker(commit, HSK_TESTNET, registry);
        vm.stopBroadcast();

        console2.log("chain id:          ", block.chainid);
        console2.log("DeploymentMarker:  ", address(marker));
        console2.log("points to registry:", registry);
        console2.logBytes32(commit);
    }

    /// @dev A 40-character hex SHA-1, right-padded with zero bytes to 32 bytes.
    function paddedCommit(string memory sha) internal pure returns (bytes32) {
        require(bytes(sha).length == 40, "DeployMarker: COMMIT_SHA must be a 40-character SHA-1");
        bytes memory raw = vm.parseBytes(string.concat("0x", sha));
        return bytes32(bytes20(raw));
    }
}
