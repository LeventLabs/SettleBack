// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {RecoveryRegistry} from "../src/RecoveryRegistry.sol";

contract RecoveryRegistryTest is Test {
    RecoveryRegistry internal registry;

    address internal verifier = makeAddr("verifier");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal delegate = makeAddr("delegate");
    address internal signer = makeAddr("signer");
    address internal token = makeAddr("token");
    address internal stranger = makeAddr("stranger");

    uint64 internal constant CHAIN = 133;
    uint256 internal constant START = 1_800_000_000;
    bytes32 internal constant SERVICE_POLICY = keccak256("extraction-delivery-v1");
    bytes32 internal constant RULES = keccak256("settleback.rules-baseline.v1");

    function setUp() public {
        vm.warp(START);
        registry = new RecoveryRegistry(verifier);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers

    function key(uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encode("case", index));
    }

    function txHash(uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encode("tx", index));
    }

    function terms(uint256 index, RecoveryRegistry.ActionKind kind, uint256 amount) internal view returns (RecoveryRegistry.CaseTerms memory) {
        return RecoveryRegistry.CaseTerms({
            buyer: buyer,
            seller: seller,
            token: token,
            amount: amount,
            paymentChainId: CHAIN,
            originalTxHash: txHash(index),
            policyHash: SERVICE_POLICY,
            eligibilityRulesHash: RULES,
            autoEligible: kind == RecoveryRegistry.ActionKind.Repay,
            actionDigest: keccak256(abi.encode("action", index)),
            evidenceDigest: keccak256(abi.encode("evidence", index)),
            kind: kind,
            deadline: uint64(block.timestamp + 1 days)
        });
    }

    function register(uint256 index, uint256 amount) internal returns (bytes32 caseKey) {
        caseKey = key(index);
        vm.prank(verifier);
        registry.registerCase(caseKey, terms(index, RecoveryRegistry.ActionKind.Repay, amount));
    }

    function registerRetrieval(uint256 index) internal returns (bytes32 caseKey) {
        caseKey = key(index);
        vm.prank(verifier);
        registry.registerCase(caseKey, terms(index, RecoveryRegistry.ActionKind.Retrieve, 1_000_000));
    }

    function policyTerms(uint256 maxPerCase, uint256 dailyLimit) internal view returns (RecoveryRegistry.PolicyTerms memory) {
        return RecoveryRegistry.PolicyTerms({
            delegate: delegate,
            signer: signer,
            token: token,
            paymentChainId: CHAIN,
            servicePolicyHash: SERVICE_POLICY,
            eligibilityRulesHash: RULES,
            maxPerCase: maxPerCase,
            dailyLimit: dailyLimit,
            validFrom: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 30 days)
        });
    }

    function activate(uint256 maxPerCase, uint256 dailyLimit) internal returns (uint64 id) {
        vm.prank(seller);
        id = registry.activatePolicy(policyTerms(maxPerCase, dailyLimit));
    }

    function scope() internal view returns (bytes32) {
        return registry.scopeOf(seller, CHAIN, token);
    }

    function state(bytes32 caseKey) internal view returns (RecoveryRegistry.CaseState) {
        return registry.getCase(caseKey).state;
    }

    function wrongState(RecoveryRegistry.CaseState current) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(RecoveryRegistry.WrongState.selector, current);
    }

    function notActive(RecoveryRegistry.PolicyStatus status) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(RecoveryRegistry.PolicyNotActive.selector, status);
    }

    // ---------------------------------------------------------------------------------------------
    // Deployment and registration

    function test_constructorFixesVerifierAndRefusesZero() public {
        assertEq(registry.verifier(), verifier);
        vm.expectRevert(RecoveryRegistry.InvalidTerms.selector);
        new RecoveryRegistry(address(0));
    }

    function test_registerStoresTermsAndEmits() public {
        RecoveryRegistry.CaseTerms memory expected = terms(1, RecoveryRegistry.ActionKind.Repay, 1_000_000);
        vm.expectEmit(true, true, false, true);
        emit RecoveryRegistry.CaseRegistered(key(1), seller, expected);
        register(1, 1_000_000);
        RecoveryRegistry.CaseRecord memory record = registry.getCase(key(1));
        assertEq(uint8(record.state), uint8(RecoveryRegistry.CaseState.Open));
        assertEq(record.terms.amount, 1_000_000);
        assertEq(record.terms.buyer, buyer);
        assertTrue(registry.referenceUsed(registry.referenceKey(CHAIN, txHash(1))));
    }

    function test_onlyVerifierRegisters() public {
        address[4] memory callers = [seller, buyer, delegate, stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(RecoveryRegistry.OnlyVerifier.selector);
            registry.registerCase(key(1), terms(1, RecoveryRegistry.ActionKind.Repay, 1));
        }
    }

    function test_registerRejectsEachInvalidField() public {
        RecoveryRegistry.CaseTerms[] memory invalid = new RecoveryRegistry.CaseTerms[](14);
        for (uint256 i = 0; i < invalid.length; i++) invalid[i] = terms(1, RecoveryRegistry.ActionKind.Repay, 1_000_000);
        invalid[0].buyer = address(0);
        invalid[1].seller = address(0);
        invalid[2].token = address(0);
        invalid[3].buyer = seller;
        invalid[4].amount = 0;
        invalid[5].paymentChainId = 0;
        invalid[6].originalTxHash = bytes32(0);
        invalid[7].policyHash = bytes32(0);
        invalid[8].eligibilityRulesHash = bytes32(0);
        invalid[9].actionDigest = bytes32(0);
        invalid[10].evidenceDigest = bytes32(0);
        invalid[11].kind = RecoveryRegistry.ActionKind.None;
        invalid[12].kind = RecoveryRegistry.ActionKind.Retrieve;
        invalid[12].autoEligible = true;
        invalid[13].buyer = address(0);
        invalid[13].seller = address(0);
        for (uint256 i = 0; i < invalid.length; i++) {
            vm.prank(verifier);
            vm.expectRevert(RecoveryRegistry.InvalidTerms.selector);
            registry.registerCase(key(1), invalid[i]);
        }
        vm.prank(verifier);
        vm.expectRevert(RecoveryRegistry.InvalidCaseKey.selector);
        registry.registerCase(bytes32(0), terms(1, RecoveryRegistry.ActionKind.Repay, 1));
    }

    function test_registerRejectsPastDeadline() public {
        RecoveryRegistry.CaseTerms memory late = terms(1, RecoveryRegistry.ActionKind.Repay, 1);
        late.deadline = uint64(block.timestamp);
        vm.prank(verifier);
        vm.expectRevert(RecoveryRegistry.DeadlineNotInFuture.selector);
        registry.registerCase(key(1), late);
    }

    function test_caseKeyAndOriginalPaymentAreUnique() public {
        register(1, 1);
        vm.prank(verifier);
        vm.expectRevert(RecoveryRegistry.CaseExists.selector);
        registry.registerCase(key(1), terms(2, RecoveryRegistry.ActionKind.Repay, 1));

        // Same original payment under another case key.
        vm.prank(verifier);
        vm.expectRevert(RecoveryRegistry.ReferenceAlreadyUsed.selector);
        registry.registerCase(key(2), terms(1, RecoveryRegistry.ActionKind.Repay, 1));

        // The same hash on another chain is a different payment.
        RecoveryRegistry.CaseTerms memory otherChain = terms(1, RecoveryRegistry.ActionKind.Repay, 1);
        otherChain.paymentChainId = 177;
        vm.prank(verifier);
        registry.registerCase(key(2), otherChain);
    }

    // ---------------------------------------------------------------------------------------------
    // Per-case reservation

    function test_onlyRecordedSellerReservesPerCase() public {
        bytes32 caseKey = register(1, 1_000_000);
        address[4] memory callers = [buyer, verifier, delegate, stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(RecoveryRegistry.OnlySeller.selector);
            registry.reserveRepayment(caseKey);
        }
        vm.expectEmit(true, true, false, true);
        emit RecoveryRegistry.RepaymentReserved(caseKey, seller, RecoveryRegistry.ReservationMode.PerCase, 0, 1_000_000, scope());
        vm.prank(seller);
        registry.reserveRepayment(caseKey);
        assertEq(uint8(state(caseKey)), uint8(RecoveryRegistry.CaseState.ReservedRepay));
        assertEq(registry.outstanding(scope()), 1_000_000);
    }

    function test_perCaseReservationRefusesRepeatsWrongKindMissingCaseAndDeadline() public {
        bytes32 caseKey = register(1, 1);
        vm.prank(seller);
        registry.reserveRepayment(caseKey);
        vm.prank(seller);
        vm.expectRevert(wrongState(RecoveryRegistry.CaseState.ReservedRepay));
        registry.reserveRepayment(caseKey);

        bytes32 retrieval = registerRetrieval(2);
        vm.prank(seller);
        vm.expectRevert(RecoveryRegistry.WrongKind.selector);
        registry.reserveRepayment(retrieval);

        vm.prank(seller);
        vm.expectRevert(RecoveryRegistry.CaseNotFound.selector);
        registry.reserveRepayment(key(99));

        bytes32 late = register(3, 1);
        vm.warp(block.timestamp + 1 days);
        vm.prank(seller);
        vm.expectRevert(RecoveryRegistry.DeadlinePassed.selector);
        registry.reserveRepayment(late);
    }

    // ---------------------------------------------------------------------------------------------
    // Completion

    function test_completeRepaymentMovesExposureToBookedOnce() public {
        bytes32 caseKey = register(1, 1_000_000);
        vm.prank(seller);
        registry.reserveRepayment(caseKey);
        uint256 day = registry.currentDay();
        vm.expectEmit(true, false, false, true);
        emit RecoveryRegistry.RepaymentCompleted(caseKey, txHash(500), keccak256("bundle"), day);
        vm.prank(verifier);
        registry.completeRepayment(caseKey, txHash(500), keccak256("bundle"));
        (uint256 bookedToday, uint256 outstandingNow) = registry.getBudget(scope(), day);
        assertEq(bookedToday, 1_000_000);
        assertEq(outstandingNow, 0);
        RecoveryRegistry.CaseRecord memory record = registry.getCase(caseKey);
        assertEq(uint8(record.state), uint8(RecoveryRegistry.CaseState.Repaid));
        assertEq(record.outcomeRef, txHash(500));

        vm.prank(verifier);
        vm.expectRevert(wrongState(RecoveryRegistry.CaseState.Repaid));
        registry.completeRepayment(caseKey, txHash(501), keccak256("bundle"));
        (bookedToday,) = registry.getBudget(scope(), day);
        assertEq(bookedToday, 1_000_000);
    }

    function test_completionRequiresVerifierReservationAndFreshReferences() public {
        bytes32 caseKey = register(1, 1);
        vm.prank(verifier);
        vm.expectRevert(wrongState(RecoveryRegistry.CaseState.Open));
        registry.completeRepayment(caseKey, txHash(500), keccak256("b"));

        vm.prank(seller);
        registry.reserveRepayment(caseKey);
        vm.prank(seller);
        vm.expectRevert(RecoveryRegistry.OnlyVerifier.selector);
        registry.completeRepayment(caseKey, txHash(500), keccak256("b"));

        vm.startPrank(verifier);
        vm.expectRevert(RecoveryRegistry.InvalidTerms.selector);
        registry.completeRepayment(caseKey, bytes32(0), keccak256("b"));
        vm.expectRevert(RecoveryRegistry.InvalidTerms.selector);
        registry.completeRepayment(caseKey, txHash(500), bytes32(0));
        // The original payment can never be presented as the repayment.
        vm.expectRevert(RecoveryRegistry.ReferenceAlreadyUsed.selector);
        registry.completeRepayment(caseKey, txHash(1), keccak256("b"));
        vm.stopPrank();
    }

    function test_repaymentProofCannotBeReusedAcrossCases() public {
        bytes32 first = register(1, 1);
        bytes32 second = register(2, 1);
        vm.startPrank(seller);
        registry.reserveRepayment(first);
        registry.reserveRepayment(second);
        vm.stopPrank();
        vm.startPrank(verifier);
        registry.completeRepayment(first, txHash(500), keccak256("b"));
        vm.expectRevert(RecoveryRegistry.ReferenceAlreadyUsed.selector);
        registry.completeRepayment(second, txHash(500), keccak256("b"));
        // Nor can a repayment proof later be registered as an original payment.
        RecoveryRegistry.CaseTerms memory reused = terms(3, RecoveryRegistry.ActionKind.Repay, 1);
        reused.originalTxHash = txHash(500);
        vm.expectRevert(RecoveryRegistry.ReferenceAlreadyUsed.selector);
        registry.registerCase(key(3), reused);
        vm.stopPrank();
    }

    function test_repaymentCanBeRecordedAfterTheDeadline() public {
        bytes32 caseKey = register(1, 1);
        vm.prank(seller);
        registry.reserveRepayment(caseKey);
        vm.warp(block.timestamp + 3 days);
        vm.prank(verifier);
        registry.completeRepayment(caseKey, txHash(500), keccak256("b"));
        assertEq(uint8(state(caseKey)), uint8(RecoveryRegistry.CaseState.Repaid));
    }

    function test_retrievalPathIsVerifierOnlyAndSeparateFromRepayment() public {
        bytes32 caseKey = registerRetrieval(1);
        vm.prank(seller);
        vm.expectRevert(RecoveryRegistry.OnlyVerifier.selector);
        registry.reserveRetrieval(caseKey);

        vm.startPrank(verifier);
        vm.expectRevert(wrongState(RecoveryRegistry.CaseState.Open));
        registry.completeRetrieval(caseKey, keccak256("artifact"), keccak256("ack"));
        registry.reserveRetrieval(caseKey);
        vm.expectRevert(wrongState(RecoveryRegistry.CaseState.ReservedRetrieve));
        registry.completeRepayment(caseKey, txHash(500), keccak256("b"));
        vm.expectRevert(RecoveryRegistry.InvalidTerms.selector);
        registry.completeRetrieval(caseKey, bytes32(0), keccak256("ack"));
        registry.completeRetrieval(caseKey, keccak256("artifact"), keccak256("ack"));
        vm.expectRevert(wrongState(RecoveryRegistry.CaseState.Recovered));
        registry.completeRetrieval(caseKey, keccak256("artifact"), keccak256("ack"));
        vm.stopPrank();
        assertEq(registry.outstanding(scope()), 0);

        bytes32 repayCase = register(2, 1);
        vm.prank(verifier);
        vm.expectRevert(RecoveryRegistry.WrongKind.selector);
        registry.reserveRetrieval(repayCase);

        bytes32 late = registerRetrieval(3);
        vm.warp(block.timestamp + 1 days);
        vm.prank(verifier);
        vm.expectRevert(RecoveryRegistry.DeadlinePassed.selector);
        registry.reserveRetrieval(late);
    }

    // ---------------------------------------------------------------------------------------------
    // Standing policies

    function test_policyStartsAbsentAndActivationIsSellerScoped() public {
        assertEq(registry.activePolicyOf(scope()), 0);
        vm.expectEmit(true, true, true, true);
        emit RecoveryRegistry.PolicyActivated(1, seller, scope(), policyTerms(2_000_000, 5_000_000), 0);
        uint64 id = activate(2_000_000, 5_000_000);
        assertEq(id, 1);
        assertEq(registry.activePolicyOf(scope()), id);
        RecoveryRegistry.Policy memory policy = registry.getPolicy(id);
        assertEq(policy.seller, seller);
        assertEq(uint8(policy.status), uint8(RecoveryRegistry.PolicyStatus.Active));
        // A stranger activating the same terms gets its own scope, not the seller's.
        vm.prank(stranger);
        registry.activatePolicy(policyTerms(2_000_000, 5_000_000));
        assertEq(registry.activePolicyOf(scope()), id);
    }

    function test_activationRejectsInvalidTerms() public {
        RecoveryRegistry.PolicyTerms[] memory invalid = new RecoveryRegistry.PolicyTerms[](11);
        for (uint256 i = 0; i < invalid.length; i++) invalid[i] = policyTerms(1, 2);
        invalid[0].delegate = address(0);
        invalid[1].signer = address(0);
        invalid[2].token = address(0);
        invalid[3].paymentChainId = 0;
        invalid[4].servicePolicyHash = bytes32(0);
        invalid[5].eligibilityRulesHash = bytes32(0);
        invalid[6].maxPerCase = 0;
        invalid[7].maxPerCase = 3;
        invalid[8].validUntil = invalid[8].validFrom;
        invalid[9].validFrom = uint64(block.timestamp + 10);
        invalid[9].validUntil = uint64(block.timestamp + 5);
        invalid[10].dailyLimit = 0;
        for (uint256 i = 0; i < invalid.length; i++) {
            vm.prank(seller);
            vm.expectRevert(RecoveryRegistry.InvalidTerms.selector);
            registry.activatePolicy(invalid[i]);
        }
        RecoveryRegistry.PolicyTerms memory expired = policyTerms(1, 2);
        expired.validFrom = uint64(block.timestamp - 10);
        expired.validUntil = uint64(block.timestamp);
        vm.prank(seller);
        vm.expectRevert(RecoveryRegistry.DeadlineNotInFuture.selector);
        registry.activatePolicy(expired);
    }

    function test_onlySellerPausesResumesAndRevokes() public {
        uint64 id = activate(1, 2);
        address[4] memory callers = [buyer, verifier, delegate, stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(RecoveryRegistry.OnlySeller.selector);
            registry.pausePolicy(id);
            vm.expectRevert(RecoveryRegistry.OnlySeller.selector);
            registry.revokePolicy(id);
            vm.stopPrank();
        }
        vm.startPrank(seller);
        registry.pausePolicy(id);
        vm.expectRevert(notActive(RecoveryRegistry.PolicyStatus.Paused));
        registry.pausePolicy(id);
        registry.resumePolicy(id);
        vm.expectRevert(notActive(RecoveryRegistry.PolicyStatus.Active));
        registry.resumePolicy(id);
        registry.revokePolicy(id);
        vm.expectRevert(notActive(RecoveryRegistry.PolicyStatus.Revoked));
        registry.resumePolicy(id);
        vm.expectRevert(notActive(RecoveryRegistry.PolicyStatus.Revoked));
        registry.revokePolicy(id);
        vm.expectRevert(RecoveryRegistry.PolicyNotFound.selector);
        registry.pausePolicy(99);
        vm.stopPrank();
        assertEq(registry.activePolicyOf(scope()), 0);
    }

    function test_pausedPolicyCannotResumeAfterExpiry() public {
        uint64 id = activate(1, 2);
        vm.prank(seller);
        registry.pausePolicy(id);
        vm.warp(block.timestamp + 30 days);
        vm.prank(seller);
        vm.expectRevert(RecoveryRegistry.PolicyOutsideValidity.selector);
        registry.resumePolicy(id);
    }

    function test_delegateReservesUnderActivePolicy() public {
        uint64 id = activate(2_000_000, 5_000_000);
        bytes32 caseKey = register(1, 1_000_000);
        vm.prank(stranger);
        vm.expectRevert(RecoveryRegistry.OnlyDelegate.selector);
        registry.reserveRepaymentUnderPolicy(caseKey, id);
        vm.prank(seller);
        vm.expectRevert(RecoveryRegistry.OnlyDelegate.selector);
        registry.reserveRepaymentUnderPolicy(caseKey, id);

        vm.expectEmit(true, true, false, true);
        emit RecoveryRegistry.RepaymentReserved(caseKey, seller, RecoveryRegistry.ReservationMode.StandingPolicy, id, 1_000_000, scope());
        vm.prank(delegate);
        registry.reserveRepaymentUnderPolicy(caseKey, id);
        RecoveryRegistry.CaseRecord memory record = registry.getCase(caseKey);
        assertEq(uint8(record.mode), uint8(RecoveryRegistry.ReservationMode.StandingPolicy));
        assertEq(record.authorizationId, id);
        assertEq(registry.outstanding(scope()), 1_000_000);
    }

    function test_policyReservationChecksEligibilityStatusAndValidity() public {
        uint64 id = activate(2_000_000, 5_000_000);
        RecoveryRegistry.CaseTerms memory manual = terms(1, RecoveryRegistry.ActionKind.Repay, 1);
        manual.autoEligible = false;
        vm.prank(verifier);
        registry.registerCase(key(1), manual);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.NotAutoEligible.selector);
        registry.reserveRepaymentUnderPolicy(key(1), id);

        bytes32 caseKey = register(2, 1);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.PolicyNotFound.selector);
        registry.reserveRepaymentUnderPolicy(caseKey, 99);

        vm.prank(seller);
        registry.pausePolicy(id);
        vm.prank(delegate);
        vm.expectRevert(notActive(RecoveryRegistry.PolicyStatus.Paused));
        registry.reserveRepaymentUnderPolicy(caseKey, id);

        vm.prank(seller);
        registry.revokePolicy(id);
        vm.prank(delegate);
        vm.expectRevert(notActive(RecoveryRegistry.PolicyStatus.Revoked));
        registry.reserveRepaymentUnderPolicy(caseKey, id);
    }

    function test_policyValidityWindowIsEnforced() public {
        RecoveryRegistry.PolicyTerms memory future = policyTerms(2, 5);
        future.validFrom = uint64(block.timestamp + 1 hours);
        future.validUntil = uint64(block.timestamp + 2 hours);
        vm.prank(seller);
        uint64 id = registry.activatePolicy(future);
        bytes32 caseKey = register(1, 1);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.PolicyOutsideValidity.selector);
        registry.reserveRepaymentUnderPolicy(caseKey, id);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.PolicyOutsideValidity.selector);
        registry.reserveRepaymentUnderPolicy(caseKey, id);
    }

    function test_policyMustMatchEveryBoundCaseField() public {
        // Each variant is built separately: assigning a memory struct copies a reference, not the value.
        RecoveryRegistry.PolicyTerms[] memory variants = new RecoveryRegistry.PolicyTerms[](2);
        variants[0] = policyTerms(2, 5);
        variants[0].servicePolicyHash = keccak256("compute-billable-v1");
        variants[1] = policyTerms(2, 5);
        variants[1].eligibilityRulesHash = keccak256("other-rules");
        for (uint256 i = 0; i < variants.length; i++) {
            vm.prank(seller);
            uint64 id = registry.activatePolicy(variants[i]);
            bytes32 caseKey = register(10 + i, 1);
            vm.prank(delegate);
            vm.expectRevert(RecoveryRegistry.PolicyMismatch.selector);
            registry.reserveRepaymentUnderPolicy(caseKey, id);
        }
        // A policy for another token or chain is in another scope, so it is not this case's current policy.
        RecoveryRegistry.PolicyTerms memory otherToken = policyTerms(2, 5);
        otherToken.token = makeAddr("other-token");
        vm.prank(seller);
        uint64 otherId = registry.activatePolicy(otherToken);
        bytes32 key2 = register(20, 1);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.PolicyNotCurrent.selector);
        registry.reserveRepaymentUnderPolicy(key2, otherId);
    }

    function test_replacedVersionCannotReserveAndExposureCarriesOver() public {
        uint64 first = activate(2_000_000, 5_000_000);
        bytes32 a = register(1, 2_000_000);
        vm.prank(delegate);
        registry.reserveRepaymentUnderPolicy(a, first);

        // The replacement has a lower daily limit than what is already outstanding.
        uint64 second = activate(1_000_000, 2_500_000);
        assertEq(uint8(registry.getPolicy(first).status), uint8(RecoveryRegistry.PolicyStatus.Replaced));
        assertEq(registry.outstanding(scope()), 2_000_000);

        bytes32 b = register(2, 1_000_000);
        vm.prank(delegate);
        vm.expectRevert(notActive(RecoveryRegistry.PolicyStatus.Replaced));
        registry.reserveRepaymentUnderPolicy(b, first);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.OverDailyLimit.selector);
        registry.reserveRepaymentUnderPolicy(b, second);
        bytes32 c = register(3, 500_000);
        vm.prank(delegate);
        registry.reserveRepaymentUnderPolicy(c, second);
        assertEq(registry.outstanding(scope()), 2_500_000);
    }

    function test_limitsAtTheirBoundaries() public {
        uint64 id = activate(1_000_000, 3_000_000);
        bytes32 tooBig = register(1, 1_000_001);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.OverPerCaseLimit.selector);
        registry.reserveRepaymentUnderPolicy(tooBig, id);

        for (uint256 i = 2; i <= 4; i++) {
            bytes32 caseKey = register(i, 1_000_000);
            vm.prank(delegate);
            registry.reserveRepaymentUnderPolicy(caseKey, id);
        }
        assertEq(registry.outstanding(scope()), 3_000_000);
        bytes32 one = register(5, 1);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.OverDailyLimit.selector);
        registry.reserveRepaymentUnderPolicy(one, id);
    }

    function test_perCaseReservationsConsumeAutomaticCapacity() public {
        uint64 id = activate(2_000_000, 2_000_000);
        // Explicit consent may go beyond the standing limit for that one case.
        bytes32 explicitCase = register(1, 3_000_000);
        vm.prank(seller);
        registry.reserveRepayment(explicitCase);
        bytes32 automatic = register(2, 1);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.OverDailyLimit.selector);
        registry.reserveRepaymentUnderPolicy(automatic, id);
    }

    function test_casesCannotSwitchModesOnceReserved() public {
        uint64 id = activate(2_000_000, 5_000_000);
        bytes32 viaSeller = register(1, 1);
        vm.prank(seller);
        registry.reserveRepayment(viaSeller);
        vm.prank(delegate);
        vm.expectRevert(wrongState(RecoveryRegistry.CaseState.ReservedRepay));
        registry.reserveRepaymentUnderPolicy(viaSeller, id);

        bytes32 viaPolicy = register(2, 1);
        vm.prank(delegate);
        registry.reserveRepaymentUnderPolicy(viaPolicy, id);
        vm.prank(seller);
        vm.expectRevert(wrongState(RecoveryRegistry.CaseState.ReservedRepay));
        registry.reserveRepayment(viaPolicy);
        vm.prank(delegate);
        vm.expectRevert(wrongState(RecoveryRegistry.CaseState.ReservedRepay));
        registry.reserveRepaymentUnderPolicy(viaPolicy, id);
    }

    function test_dayRolloverKeepsOutstandingButNotPriorBookings() public {
        uint64 id = activate(1_000_000, 2_000_000);
        bytes32 settled = register(1, 1_000_000);
        bytes32 held = register(2, 1_000_000);
        vm.startPrank(delegate);
        registry.reserveRepaymentUnderPolicy(settled, id);
        registry.reserveRepaymentUnderPolicy(held, id);
        vm.stopPrank();
        vm.prank(verifier);
        registry.completeRepayment(settled, txHash(500), keccak256("b"));

        // Same day: 1,000,000 booked + 1,000,000 outstanding leaves no room.
        bytes32 sameDay = register(3, 1);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.OverDailyLimit.selector);
        registry.reserveRepaymentUnderPolicy(sameDay, id);

        // Next UTC day: yesterday's booking no longer counts; the held reservation still does.
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        bytes32 nextDay = register(4, 1_000_000);
        vm.prank(delegate);
        registry.reserveRepaymentUnderPolicy(nextDay, id);
        bytes32 overflow = register(5, 1);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.OverDailyLimit.selector);
        registry.reserveRepaymentUnderPolicy(overflow, id);
        assertEq(registry.outstanding(scope()), 2_000_000);
    }

    function test_uncertainReservationsAreNeverReleased() public {
        uint64 id = activate(1_000_000, 1_000_000);
        bytes32 unknown = register(1, 1_000_000);
        vm.prank(delegate);
        registry.reserveRepaymentUnderPolicy(unknown, id);
        // Pausing, revoking, replacing, waiting past the deadline, and crossing days release nothing.
        vm.startPrank(seller);
        registry.pausePolicy(id);
        registry.revokePolicy(id);
        vm.stopPrank();
        uint64 replacement = activate(1_000_000, 1_000_000);
        vm.warp(block.timestamp + 5 days);
        assertEq(registry.outstanding(scope()), 1_000_000);
        assertEq(uint8(state(unknown)), uint8(RecoveryRegistry.CaseState.ReservedRepay));
        bytes32 next = register(2, 1);
        vm.prank(delegate);
        vm.expectRevert(RecoveryRegistry.OverDailyLimit.selector);
        registry.reserveRepaymentUnderPolicy(next, replacement);
    }

    function test_twentyQueuedReservationsAppliedSeriallyStopAtTheLimit() public {
        uint64 id = activate(1_000_000, 10_000_000);
        uint256 accepted;
        uint256 refused;
        for (uint256 i = 1; i <= 20; i++) {
            bytes32 caseKey = register(i, 1_000_000);
            vm.prank(delegate);
            try registry.reserveRepaymentUnderPolicy(caseKey, id) {
                accepted++;
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), RecoveryRegistry.OverDailyLimit.selector);
                refused++;
            }
        }
        assertEq(accepted, 10);
        assertEq(refused, 10);
        assertEq(registry.outstanding(scope()), 10_000_000);
    }

    function test_revokedPolicyStillAllowsCompletingAlreadyReservedWork() public {
        uint64 id = activate(1_000_000, 1_000_000);
        bytes32 caseKey = register(1, 1_000_000);
        vm.prank(delegate);
        registry.reserveRepaymentUnderPolicy(caseKey, id);
        vm.prank(seller);
        registry.revokePolicy(id);
        vm.prank(verifier);
        registry.completeRepayment(caseKey, txHash(500), keccak256("b"));
        assertEq(registry.outstanding(scope()), 0);
    }

    function test_holdsNoEtherAndHasNoFallback() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(registry).call{value: 1 wei}("");
        assertFalse(ok);
        assertEq(address(registry).balance, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Fuzz

    function testFuzz_amountRoundTripsThroughTheLedger(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);
        bytes32 caseKey = register(1, amount);
        vm.prank(seller);
        registry.reserveRepayment(caseKey);
        assertEq(registry.outstanding(scope()), amount);
        vm.prank(verifier);
        registry.completeRepayment(caseKey, txHash(500), keccak256("b"));
        (uint256 bookedToday, uint256 outstandingNow) = registry.getBudget(scope(), registry.currentDay());
        assertEq(bookedToday, amount);
        assertEq(outstandingNow, 0);
    }

    function testFuzz_nobodyButTheSellerReservesPerCase(address caller) public {
        vm.assume(caller != seller);
        bytes32 caseKey = register(1, 1);
        vm.prank(caller);
        vm.expectRevert(RecoveryRegistry.OnlySeller.selector);
        registry.reserveRepayment(caseKey);
    }

    function testFuzz_nobodyButTheVerifierRecordsOutcomes(address caller) public {
        vm.assume(caller != verifier);
        bytes32 caseKey = register(1, 1);
        vm.prank(seller);
        registry.reserveRepayment(caseKey);
        vm.prank(caller);
        vm.expectRevert(RecoveryRegistry.OnlyVerifier.selector);
        registry.completeRepayment(caseKey, txHash(500), keccak256("b"));
    }

    function testFuzz_nobodyButTheDelegateReservesUnderPolicy(address caller) public {
        vm.assume(caller != delegate);
        uint64 id = activate(1, 1);
        bytes32 caseKey = register(1, 1);
        vm.prank(caller);
        vm.expectRevert(RecoveryRegistry.OnlyDelegate.selector);
        registry.reserveRepaymentUnderPolicy(caseKey, id);
    }

    function testFuzz_reservationOnlyBeforeTheDeadline(uint64 deadlineOffset, uint64 elapsed) public {
        deadlineOffset = uint64(bound(deadlineOffset, 1, 365 days));
        elapsed = uint64(bound(elapsed, 0, 2 * 365 days));
        RecoveryRegistry.CaseTerms memory t = terms(1, RecoveryRegistry.ActionKind.Repay, 1);
        t.deadline = uint64(block.timestamp) + deadlineOffset;
        vm.prank(verifier);
        registry.registerCase(key(1), t);
        vm.warp(block.timestamp + elapsed);
        vm.prank(seller);
        if (elapsed >= deadlineOffset) vm.expectRevert(RecoveryRegistry.DeadlinePassed.selector);
        registry.reserveRepayment(key(1));
    }

    function testFuzz_dailyLimitBoundary(uint256 existing, uint256 amount, uint256 limit) public {
        limit = bound(limit, 1, type(uint64).max);
        existing = bound(existing, 0, limit);
        amount = bound(amount, 1, limit);
        uint64 id = activate(limit, limit);
        if (existing > 0) {
            bytes32 explicitCase = register(1, existing);
            vm.prank(seller);
            registry.reserveRepayment(explicitCase);
        }
        bytes32 caseKey = register(2, amount);
        vm.prank(delegate);
        if (existing + amount > limit) vm.expectRevert(RecoveryRegistry.OverDailyLimit.selector);
        registry.reserveRepaymentUnderPolicy(caseKey, id);
    }
}
