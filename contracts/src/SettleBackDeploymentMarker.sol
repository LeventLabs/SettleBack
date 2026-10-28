// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title SettleBackDeploymentMarker
/// @notice Immutable record that points from one network to the RecoveryRegistry deployment that
///         SettleBack uses on another: the source commit, the registry's chain and address, the
///         deployer, and the deployment time. It is a pointer, not the registry.
/// @dev Holds no funds and has no state-changing functions after construction: no owner, no
///      fallback or receive, no proxy, no delegatecall, no selfdestruct.
contract SettleBackDeploymentMarker {
    string public constant PROJECT = "SettleBack";

    address public immutable deployer;
    /// @notice Git commit SHA-1 of the source at deployment, right-padded with zero bytes.
    bytes32 public immutable commit;
    uint256 public immutable registryChainId;
    address public immutable registry;
    uint256 public immutable deployedAt;

    event Deployed(address indexed deployer, bytes32 commit, uint256 registryChainId, address registry, uint256 timestamp);

    error InvalidReference();

    constructor(bytes32 commit_, uint256 registryChainId_, address registry_) {
        // The low 12 bytes must be zero: a SHA-1 is 20 bytes.
        if (commit_ == bytes32(0) || uint96(uint256(commit_)) != 0 || registryChainId_ == 0 || registry_ == address(0)) {
            revert InvalidReference();
        }
        deployer = msg.sender;
        commit = commit_;
        registryChainId = registryChainId_;
        registry = registry_;
        deployedAt = block.timestamp;
        emit Deployed(msg.sender, commit_, registryChainId_, registry_, block.timestamp);
    }
}
