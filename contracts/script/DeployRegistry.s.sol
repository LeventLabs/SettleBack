// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {RecoveryRegistry} from "../src/RecoveryRegistry.sol";

/// @notice Deploys the RecoveryRegistry to HSK Chain testnet (133). Mainnet waits for a security
///         review, so this script refuses chain 177.
///
///   SETTLEBACK_VERIFIER=0x... forge script script/DeployRegistry.s.sol:DeployRegistry \
///     --rpc-url https://testnet.hsk.xyz --account <keystore> --sender <deployer> --broadcast
///
/// The deployer pays gas and has no authority over the contract. The verifier address is fixed for
/// the contract's lifetime and must be a separate key from the deployer.
contract DeployRegistry is Script {
    uint256 internal constant HSK_TESTNET = 133;

    function run() external returns (RecoveryRegistry registry) {
        address verifier = vm.envAddress("SETTLEBACK_VERIFIER");
        require(block.chainid == HSK_TESTNET, "DeployRegistry: only HSK Chain testnet (133)");
        require(verifier != address(0), "DeployRegistry: verifier is required");
        require(verifier != msg.sender, "DeployRegistry: use a verifier key separate from the deployer");

        vm.startBroadcast();
        registry = new RecoveryRegistry(verifier);
        vm.stopBroadcast();

        require(registry.verifier() == verifier, "DeployRegistry: verifier mismatch after deployment");
        console2.log("chain id:        ", block.chainid);
        console2.log("RecoveryRegistry:", address(registry));
        console2.log("verifier:        ", verifier);
        console2.log("deployer:        ", msg.sender);
    }
}
