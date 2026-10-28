// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";

/// @notice Chooses the deployment signer. With DEPLOYER_PRIVATE_KEY set (from the gitignored
///         contracts/.env, which the server never loads) it signs with that key and requires the
///         key to belong to DEPLOYER_ADDRESS, so a mistyped or malformed key fails before anything
///         is sent. Without it, it signs with the --account/--sender given on the command line.
abstract contract DeployBase is Script {
    function deployerKey() internal view returns (uint256 key, address deployer) {
        string memory raw = vm.envOr("DEPLOYER_PRIVATE_KEY", string(""));
        if (bytes(raw).length == 0) return (0, msg.sender);
        // Exactly 0x plus 64 hex digits: without the prefix the value would be read as a decimal number.
        require(bytes(raw).length == 66 && bytes(raw)[0] == "0" && bytes(raw)[1] == "x", "Deploy: DEPLOYER_PRIVATE_KEY must be 0x followed by 64 hex digits");
        key = vm.parseUint(raw);
        deployer = vm.addr(key);
        require(deployer == vm.envAddress("DEPLOYER_ADDRESS"), "Deploy: DEPLOYER_PRIVATE_KEY does not belong to DEPLOYER_ADDRESS");
    }

    function startBroadcastAs(uint256 key) internal {
        if (key == 0) vm.startBroadcast();
        else vm.startBroadcast(key);
    }
}
