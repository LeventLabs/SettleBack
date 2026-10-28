// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {SettleBackDeploymentMarker} from "../src/SettleBackDeploymentMarker.sol";

contract SettleBackDeploymentMarkerTest is Test {
    bytes32 internal constant COMMIT = bytes32(hex"8c28b89ab0000000000000000000000000000001000000000000000000000000");
    address internal registry = makeAddr("registry");
    address internal deployer = makeAddr("deployer");

    function test_recordsTheRegistryPointerAndDeployment() public {
        vm.warp(1_800_000_000);
        vm.expectEmit(true, false, false, true);
        emit SettleBackDeploymentMarker.Deployed(deployer, COMMIT, 133, registry, 1_800_000_000);
        vm.prank(deployer);
        SettleBackDeploymentMarker marker = new SettleBackDeploymentMarker(COMMIT, 133, registry);
        assertEq(marker.PROJECT(), "SettleBack");
        assertEq(marker.deployer(), deployer);
        assertEq(marker.commit(), COMMIT);
        assertEq(marker.registryChainId(), 133);
        assertEq(marker.registry(), registry);
        assertEq(marker.deployedAt(), 1_800_000_000);
    }

    function test_refusesAnIncompletePointer() public {
        vm.expectRevert(SettleBackDeploymentMarker.InvalidReference.selector);
        new SettleBackDeploymentMarker(bytes32(0), 133, registry);
        vm.expectRevert(SettleBackDeploymentMarker.InvalidReference.selector);
        new SettleBackDeploymentMarker(COMMIT, 0, registry);
        vm.expectRevert(SettleBackDeploymentMarker.InvalidReference.selector);
        new SettleBackDeploymentMarker(COMMIT, 133, address(0));
        // A full 32-byte value is not a padded SHA-1 commit.
        vm.expectRevert(SettleBackDeploymentMarker.InvalidReference.selector);
        new SettleBackDeploymentMarker(keccak256("not a commit"), 133, registry);
    }

    function test_acceptsNoEtherAndExposesNoMutation() public {
        SettleBackDeploymentMarker marker = new SettleBackDeploymentMarker(COMMIT, 133, registry);
        vm.deal(address(this), 1 ether);
        (bool sent,) = address(marker).call{value: 1 wei}("");
        assertFalse(sent);
        (bool called,) = address(marker).call(abi.encodeWithSignature("setRegistry(address)", address(1)));
        assertFalse(called);
        assertEq(marker.registry(), registry);
    }
}
