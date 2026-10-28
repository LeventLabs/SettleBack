// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {RecoveryRegistry} from "../src/RecoveryRegistry.sol";

/// @dev Drives the registry through random sequences of valid and invalid calls from every role.
contract RegistryHandler is Test {
    RecoveryRegistry public immutable registry;
    address public immutable verifier;
    address public immutable seller;
    address public immutable buyer;
    address public immutable delegate;
    address public immutable token;
    uint64 public constant CHAIN = 133;

    bytes32[] public caseKeys;
    mapping(bytes32 caseKey => RecoveryRegistry.CaseState) public terminalSeen;
    uint64[] public policyIds;
    uint256 public bookedTotal;
    uint256 public nextIndex = 1;
    bool public terminalChanged;
    uint256 public perCaseReservations;
    uint256 public policyReservations;
    uint256 public retrievalReservations;
    uint256 public repayments;
    uint256 public retrievals;

    constructor(RecoveryRegistry registry_, address verifier_) {
        registry = registry_;
        verifier = verifier_;
        seller = makeAddr("seller");
        buyer = makeAddr("buyer");
        delegate = makeAddr("delegate");
        token = makeAddr("token");
    }

    function caseCount() external view returns (uint256) {
        return caseKeys.length;
    }

    function scope() public view returns (bytes32) {
        return registry.scopeOf(seller, CHAIN, token);
    }

    function originalRef(uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encode("tx", index));
    }

    function registerCase(uint256 amountSeed, bool retrieve, bool autoEligible) external {
        uint256 index = nextIndex++;
        RecoveryRegistry.ActionKind kind = retrieve ? RecoveryRegistry.ActionKind.Retrieve : RecoveryRegistry.ActionKind.Repay;
        RecoveryRegistry.CaseTerms memory terms = RecoveryRegistry.CaseTerms({
            buyer: buyer,
            seller: seller,
            token: token,
            amount: bound(amountSeed, 1, 2_000_000),
            paymentChainId: CHAIN,
            originalTxHash: originalRef(index),
            policyHash: keccak256("service"),
            eligibilityRulesHash: keccak256("rules"),
            // Mostly eligible, so the standing-policy path is exercised; one in four needs explicit consent.
            autoEligible: !retrieve && (autoEligible || amountSeed % 4 != 0),
            actionDigest: keccak256(abi.encode("a", index)),
            evidenceDigest: keccak256(abi.encode("e", index)),
            kind: kind,
            deadline: uint64(block.timestamp + 3 days)
        });
        bytes32 caseKey = keccak256(abi.encode("case", index));
        vm.prank(verifier);
        registry.registerCase(caseKey, terms);
        caseKeys.push(caseKey);
        sync();
    }

    function reservePerCase(uint256 caseSeed) external {
        if (caseKeys.length == 0) return;
        // Pick before pranking: the pick reads the registry, which would consume the prank.
        bytes32 caseKey = pickWhere(caseSeed, RecoveryRegistry.CaseState.Open, RecoveryRegistry.ActionKind.Repay);
        vm.prank(seller);
        try registry.reserveRepayment(caseKey) {
            perCaseReservations++;
        } catch {}
        sync();
    }

    function reserveUnderPolicy(uint256 caseSeed, uint256 policySeed) external {
        if (caseKeys.length == 0 || policyIds.length == 0) return;
        // Usually the scope's current version; otherwise any version, including replaced and revoked ones.
        uint64 current = registry.activePolicyOf(scope());
        uint64 id = current != 0 && policySeed % 4 != 0 ? current : policyIds[policySeed % policyIds.length];
        bytes32 caseKey = pickWhere(caseSeed, RecoveryRegistry.CaseState.Open, RecoveryRegistry.ActionKind.Repay);
        vm.prank(delegate);
        try registry.reserveRepaymentUnderPolicy(caseKey, id) {
            policyReservations++;
        } catch {}
        sync();
    }

    function reserveRetrieval(uint256 caseSeed) external {
        if (caseKeys.length == 0) return;
        bytes32 caseKey = pickWhere(caseSeed, RecoveryRegistry.CaseState.Open, RecoveryRegistry.ActionKind.Retrieve);
        vm.prank(verifier);
        try registry.reserveRetrieval(caseKey) {
            retrievalReservations++;
        } catch {}
        sync();
    }

    function completeRepayment(uint256 caseSeed, uint256 refSeed) external {
        if (caseKeys.length == 0) return;
        bytes32 caseKey = pickWhere(caseSeed, RecoveryRegistry.CaseState.ReservedRepay, RecoveryRegistry.ActionKind.Repay);
        uint256 amount = registry.getCase(caseKey).terms.amount;
        // Small ref space, so reused and original references are tried often.
        bytes32 ref = keccak256(abi.encode("tx", bound(refSeed, 1, 40)));
        vm.prank(verifier);
        try registry.completeRepayment(caseKey, ref, keccak256("bundle")) {
            bookedTotal += amount;
            repayments++;
        } catch {}
        sync();
    }

    function completeRetrieval(uint256 caseSeed) external {
        if (caseKeys.length == 0) return;
        bytes32 caseKey = pickWhere(caseSeed, RecoveryRegistry.CaseState.ReservedRetrieve, RecoveryRegistry.ActionKind.Retrieve);
        vm.prank(verifier);
        try registry.completeRetrieval(caseKey, keccak256("artifact"), keccak256("ack")) {
            retrievals++;
        } catch {}
        sync();
    }

    function activatePolicy(uint256 maxSeed, uint256 limitSeed) external {
        uint256 maxPerCase = bound(maxSeed, 500_000, 2_500_000);
        uint256 dailyLimit = bound(limitSeed, maxPerCase, 20_000_000);
        RecoveryRegistry.PolicyTerms memory terms = RecoveryRegistry.PolicyTerms({
            delegate: delegate,
            signer: makeAddr("signer"),
            token: token,
            paymentChainId: CHAIN,
            servicePolicyHash: keccak256("service"),
            eligibilityRulesHash: keccak256("rules"),
            maxPerCase: maxPerCase,
            dailyLimit: dailyLimit,
            validFrom: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 7 days)
        });
        vm.prank(seller);
        policyIds.push(registry.activatePolicy(terms));
        sync();
    }

    function changePolicy(uint256 policySeed, uint8 action) external {
        if (policyIds.length == 0) return;
        uint64 id = policyIds[policySeed % policyIds.length];
        vm.startPrank(seller);
        // Resume is the most common change, so paused policies come back into use.
        if (action % 4 == 0) try registry.pausePolicy(id) {} catch {}
        else if (action % 4 == 1) try registry.revokePolicy(id) {} catch {}
        else try registry.resumePolicy(id) {} catch {}
        vm.stopPrank();
        sync();
    }

    function strangerCalls(address caller, uint256 caseSeed) external {
        if (caseKeys.length == 0 || caller == seller || caller == verifier || caller == delegate) return;
        bytes32 caseKey = pick(caseSeed);
        vm.startPrank(caller);
        try registry.reserveRepayment(caseKey) {} catch {}
        try registry.reserveRetrieval(caseKey) {} catch {}
        try registry.completeRepayment(caseKey, keccak256("stranger"), keccak256("b")) {} catch {}
        try registry.completeRetrieval(caseKey, keccak256("x"), keccak256("y")) {} catch {}
        if (policyIds.length > 0) try registry.reserveRepaymentUnderPolicy(caseKey, policyIds[0]) {} catch {}
        vm.stopPrank();
        sync();
    }

    /// @dev Small steps, so cases stay open long enough to be acted on while UTC days still roll over.
    function passTime(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 8 hours));
        sync();
    }

    function pick(uint256 seed) internal view returns (bytes32) {
        return caseKeys[seed % caseKeys.length];
    }

    /// @dev Usually a case in the state and kind the action expects; one call in four takes any case,
    ///      so invalid transitions keep being tried.
    function pickWhere(uint256 seed, RecoveryRegistry.CaseState wanted, RecoveryRegistry.ActionKind kind) internal view returns (bytes32) {
        if (seed % 4 == 0) return pick(seed / 4);
        uint256 start = seed % caseKeys.length;
        for (uint256 offset = 0; offset < caseKeys.length; offset++) {
            bytes32 candidate = caseKeys[(start + offset) % caseKeys.length];
            RecoveryRegistry.CaseRecord memory record = registry.getCase(candidate);
            if (record.state == wanted && record.terms.kind == kind) return candidate;
        }
        return pick(seed);
    }

    /// @dev Records each case's first terminal state and flags any later change.
    function sync() internal {
        for (uint256 i = 0; i < caseKeys.length; i++) {
            RecoveryRegistry.CaseState current = registry.getCase(caseKeys[i]).state;
            RecoveryRegistry.CaseState seen = terminalSeen[caseKeys[i]];
            if (seen != RecoveryRegistry.CaseState.None && seen != current) terminalChanged = true;
            if (current == RecoveryRegistry.CaseState.Repaid || current == RecoveryRegistry.CaseState.Recovered) terminalSeen[caseKeys[i]] = current;
        }
    }
}

contract RecoveryRegistryInvariantTest is Test {
    RecoveryRegistry internal registry;
    RegistryHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        address verifier = makeAddr("verifier");
        registry = new RecoveryRegistry(verifier);
        handler = new RegistryHandler(registry, verifier);
        targetContract(address(handler));
    }

    /// @notice The handler can reach every reservation and outcome, so the invariants are not vacuous.
    function test_handlerReachesEveryOutcome() public {
        handler.activatePolicy(1_000_000, 10_000_000);
        handler.registerCase(500_000, false, true); // case 1: automatic repayment
        handler.reserveUnderPolicy(0, 0);
        handler.completeRepayment(0, 1_000); // bounded to ref 40, which no case uses yet
        handler.registerCase(1, true, false); // case 2: retrieval
        handler.reserveRetrieval(1);
        handler.completeRetrieval(1);
        handler.registerCase(700_000, false, false); // case 3: per-case repayment
        handler.reservePerCase(2);
        assertEq(handler.policyReservations(), 1);
        assertEq(handler.repayments(), 1);
        assertEq(handler.retrievalReservations(), 1);
        assertEq(handler.retrievals(), 1);
        assertEq(handler.perCaseReservations(), 1);
        assertEq(registry.outstanding(handler.scope()), 700_000);
    }

    /// @notice Outstanding exposure is exactly the reserved, unfinished repayments.
    function invariant_outstandingEqualsReservedRepayments() public view {
        uint256 reserved;
        for (uint256 i = 0; i < handler.caseCount(); i++) {
            RecoveryRegistry.CaseRecord memory record = registry.getCase(handler.caseKeys(i));
            if (record.state == RecoveryRegistry.CaseState.ReservedRepay) reserved += record.terms.amount;
        }
        assertEq(registry.outstanding(handler.scope()), reserved);
    }

    /// @notice Every repaid case was booked exactly once.
    function invariant_bookedEqualsRepaidCases() public view {
        uint256 repaid;
        for (uint256 i = 0; i < handler.caseCount(); i++) {
            RecoveryRegistry.CaseRecord memory record = registry.getCase(handler.caseKeys(i));
            if (record.state == RecoveryRegistry.CaseState.Repaid) repaid += record.terms.amount;
        }
        assertEq(handler.bookedTotal(), repaid);
    }

    /// @notice A case reaches at most one terminal state and never leaves it.
    function invariant_terminalStatesNeverChange() public view {
        assertFalse(handler.terminalChanged());
    }

    /// @notice Every recorded outcome matches the case kind, and policy reservations name a policy.
    function invariant_outcomesMatchKindAndMode() public view {
        for (uint256 i = 0; i < handler.caseCount(); i++) {
            RecoveryRegistry.CaseRecord memory record = registry.getCase(handler.caseKeys(i));
            if (record.state == RecoveryRegistry.CaseState.Repaid || record.state == RecoveryRegistry.CaseState.ReservedRepay) {
                assertEq(uint8(record.terms.kind), uint8(RecoveryRegistry.ActionKind.Repay));
                assertTrue(record.mode != RecoveryRegistry.ReservationMode.None);
                assertEq(record.mode == RecoveryRegistry.ReservationMode.StandingPolicy, record.authorizationId != 0);
            }
            if (record.state == RecoveryRegistry.CaseState.Recovered || record.state == RecoveryRegistry.CaseState.ReservedRetrieve) {
                assertEq(uint8(record.terms.kind), uint8(RecoveryRegistry.ActionKind.Retrieve));
            }
            assertTrue(registry.referenceUsed(registry.referenceKey(handler.CHAIN(), record.terms.originalTxHash)));
        }
    }
}
