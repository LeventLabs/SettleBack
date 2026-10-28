// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title RecoveryRegistry
/// @notice Records recovery cases for paid agent jobs, the authority under which a repayment was
///         reserved, and each case's single outcome. Payments themselves happen through the payment
///         gateway; this contract only records them.
/// @dev Holds no tokens and makes no external calls. There is no owner, upgrade path, case
///      cancellation, budget reset, or reservation release. The verifier is fixed at deployment and
///      is trusted to register cases and record outcomes truthfully; it cannot reserve repayments,
///      act as a seller, or change a seller's policy. A compromised verifier can corrupt case
///      records and accounting, but cannot move funds.
contract RecoveryRegistry {
    enum CaseState {
        None,
        Open,
        ReservedRepay,
        ReservedRetrieve,
        Repaid,
        Recovered
    }

    enum ActionKind {
        None,
        Repay,
        Retrieve
    }

    enum ReservationMode {
        None,
        PerCase,
        StandingPolicy
    }

    enum PolicyStatus {
        None,
        Active,
        Paused,
        Revoked,
        Replaced
    }

    /// @notice Fixed terms of a case. `paymentChainId` qualifies every payment reference, so a
    ///         payment on one network cannot stand in for a payment on another.
    struct CaseTerms {
        address buyer;
        address seller;
        address token;
        uint256 amount;
        uint64 paymentChainId;
        bytes32 originalTxHash;
        bytes32 policyHash;
        bytes32 eligibilityRulesHash;
        bool autoEligible;
        bytes32 actionDigest;
        bytes32 evidenceDigest;
        ActionKind kind;
        uint64 deadline;
    }

    struct CaseRecord {
        CaseTerms terms;
        CaseState state;
        ReservationMode mode;
        uint64 authorizationId;
        /// @dev Repayment transaction hash, or the delivered artifact's digest.
        bytes32 outcomeRef;
        /// @dev Evidence bundle digest, or the buyer acknowledgement digest.
        bytes32 outcomeCommitment;
    }

    /// @notice A seller's standing authority for automatic repayments, immutable once activated.
    struct PolicyTerms {
        address delegate;
        address signer;
        address token;
        uint64 paymentChainId;
        bytes32 servicePolicyHash;
        bytes32 eligibilityRulesHash;
        uint256 maxPerCase;
        uint256 dailyLimit;
        uint64 validFrom;
        uint64 validUntil;
    }

    struct Policy {
        address seller;
        PolicyTerms terms;
        PolicyStatus status;
    }

    address public immutable verifier;

    /// @notice Number of policy versions ever activated; authorization IDs start at 1.
    uint64 public policyCount;

    mapping(bytes32 caseKey => CaseRecord) private cases;
    mapping(bytes32 refKey => bool) public referenceUsed;
    mapping(uint64 authorizationId => Policy) private policies;
    /// @notice The active policy for a seller, payment chain, and token; 0 when none.
    mapping(bytes32 scope => uint64) public activePolicyOf;
    /// @notice Reserved repayment amounts not yet recorded as repaid, across all days and policy versions.
    mapping(bytes32 scope => uint256) public outstanding;
    /// @notice Repaid amounts by the UTC day the outcome was recorded.
    mapping(bytes32 scope => mapping(uint256 day => uint256)) public booked;

    event CaseRegistered(bytes32 indexed caseKey, address indexed seller, CaseTerms terms);
    event RepaymentReserved(
        bytes32 indexed caseKey, address indexed seller, ReservationMode mode, uint64 authorizationId, uint256 amount, bytes32 scope
    );
    event RetrievalReserved(bytes32 indexed caseKey);
    event RepaymentCompleted(bytes32 indexed caseKey, bytes32 repaymentTxHash, bytes32 evidenceBundleHash, uint256 day);
    event RetrievalCompleted(bytes32 indexed caseKey, bytes32 artifactHash, bytes32 acknowledgementHash);
    event PolicyActivated(
        uint64 indexed authorizationId, address indexed seller, bytes32 indexed scope, PolicyTerms terms, uint64 replacedAuthorizationId
    );
    event PolicyPaused(uint64 indexed authorizationId);
    event PolicyResumed(uint64 indexed authorizationId);
    event PolicyRevoked(uint64 indexed authorizationId);

    error OnlyVerifier();
    error OnlySeller();
    error OnlyDelegate();
    error InvalidCaseKey();
    error CaseExists();
    error CaseNotFound();
    error InvalidTerms();
    error DeadlineNotInFuture();
    error DeadlinePassed();
    error ReferenceAlreadyUsed();
    error WrongState(CaseState state);
    error WrongKind();
    error NotAutoEligible();
    error PolicyNotFound();
    error PolicyNotActive(PolicyStatus status);
    error PolicyNotCurrent();
    error PolicyOutsideValidity();
    error PolicyMismatch();
    error OverPerCaseLimit();
    error OverDailyLimit();

    modifier onlyVerifier() {
        if (msg.sender != verifier) revert OnlyVerifier();
        _;
    }

    constructor(address verifier_) {
        if (verifier_ == address(0)) revert InvalidTerms();
        verifier = verifier_;
    }

    // ---------------------------------------------------------------------------------------------
    // Cases

    /// @notice Registers a case with fixed terms and binds its original payment reference for good.
    function registerCase(bytes32 caseKey, CaseTerms calldata terms) external onlyVerifier {
        if (caseKey == bytes32(0)) revert InvalidCaseKey();
        if (cases[caseKey].state != CaseState.None) revert CaseExists();
        if (
            terms.buyer == address(0) || terms.seller == address(0) || terms.token == address(0) || terms.buyer == terms.seller
                || terms.amount == 0 || terms.paymentChainId == 0 || terms.originalTxHash == bytes32(0)
                || terms.policyHash == bytes32(0) || terms.eligibilityRulesHash == bytes32(0) || terms.actionDigest == bytes32(0)
                || terms.evidenceDigest == bytes32(0) || terms.kind == ActionKind.None
                || (terms.kind == ActionKind.Retrieve && terms.autoEligible)
        ) revert InvalidTerms();
        if (terms.deadline <= block.timestamp) revert DeadlineNotInFuture();

        bytes32 refKey = referenceKey(terms.paymentChainId, terms.originalTxHash);
        if (referenceUsed[refKey]) revert ReferenceAlreadyUsed();
        referenceUsed[refKey] = true;

        CaseRecord storage record = cases[caseKey];
        record.terms = terms;
        record.state = CaseState.Open;
        emit CaseRegistered(caseKey, terms.seller, terms);
    }

    /// @notice The seller reserves a repayment for one case with explicit per-case consent. Its
    ///         amount joins the scope's outstanding exposure, which automatic reservations respect;
    ///         this path itself is not limited by a standing policy.
    function reserveRepayment(bytes32 caseKey) external {
        CaseRecord storage record = openRepayment(caseKey);
        if (msg.sender != record.terms.seller) revert OnlySeller();
        bytes32 scope = scopeOf(record.terms.seller, record.terms.paymentChainId, record.terms.token);
        record.state = CaseState.ReservedRepay;
        record.mode = ReservationMode.PerCase;
        outstanding[scope] += record.terms.amount;
        emit RepaymentReserved(caseKey, record.terms.seller, ReservationMode.PerCase, 0, record.terms.amount, scope);
    }

    /// @notice The seller's delegate reserves a repayment under the seller's active standing policy.
    ///         Every field the policy binds must match the case, and the amount must fit both the
    ///         per-case limit and today's limit after everything already booked today and everything
    ///         still outstanding from any day or version.
    function reserveRepaymentUnderPolicy(bytes32 caseKey, uint64 authorizationId) external {
        CaseRecord storage record = openRepayment(caseKey);
        if (!record.terms.autoEligible) revert NotAutoEligible();
        Policy storage policy = policies[authorizationId];
        if (policy.status == PolicyStatus.None) revert PolicyNotFound();
        if (msg.sender != policy.terms.delegate) revert OnlyDelegate();
        if (policy.status != PolicyStatus.Active) revert PolicyNotActive(policy.status);

        CaseTerms storage terms = record.terms;
        bytes32 scope = scopeOf(terms.seller, terms.paymentChainId, terms.token);
        if (activePolicyOf[scope] != authorizationId) revert PolicyNotCurrent();
        if (block.timestamp < policy.terms.validFrom || block.timestamp >= policy.terms.validUntil) revert PolicyOutsideValidity();
        if (
            policy.seller != terms.seller || policy.terms.token != terms.token || policy.terms.paymentChainId != terms.paymentChainId
                || policy.terms.servicePolicyHash != terms.policyHash || policy.terms.eligibilityRulesHash != terms.eligibilityRulesHash
        ) revert PolicyMismatch();
        if (terms.amount > policy.terms.maxPerCase) revert OverPerCaseLimit();
        if (booked[scope][currentDay()] + outstanding[scope] + terms.amount > policy.terms.dailyLimit) revert OverDailyLimit();

        record.state = CaseState.ReservedRepay;
        record.mode = ReservationMode.StandingPolicy;
        record.authorizationId = authorizationId;
        outstanding[scope] += terms.amount;
        emit RepaymentReserved(caseKey, terms.seller, ReservationMode.StandingPolicy, authorizationId, terms.amount, scope);
    }

    /// @notice The verifier reserves retrieval of an existing result; no money is involved.
    function reserveRetrieval(bytes32 caseKey) external onlyVerifier {
        CaseRecord storage record = existing(caseKey);
        if (record.state != CaseState.Open) revert WrongState(record.state);
        if (record.terms.kind != ActionKind.Retrieve) revert WrongKind();
        if (block.timestamp >= record.terms.deadline) revert DeadlinePassed();
        record.state = CaseState.ReservedRetrieve;
        emit RetrievalReserved(caseKey);
    }

    /// @notice Records a verified repayment. Its amount moves from outstanding to today's booked
    ///         total in one step. Allowed after the deadline, because a transfer issued in time may
    ///         settle later. The repayment reference can never have been used before, including as
    ///         any case's original payment.
    function completeRepayment(bytes32 caseKey, bytes32 repaymentTxHash, bytes32 evidenceBundleHash) external onlyVerifier {
        CaseRecord storage record = existing(caseKey);
        if (record.state != CaseState.ReservedRepay) revert WrongState(record.state);
        if (repaymentTxHash == bytes32(0) || evidenceBundleHash == bytes32(0)) revert InvalidTerms();
        bytes32 refKey = referenceKey(record.terms.paymentChainId, repaymentTxHash);
        if (referenceUsed[refKey]) revert ReferenceAlreadyUsed();
        referenceUsed[refKey] = true;

        bytes32 scope = scopeOf(record.terms.seller, record.terms.paymentChainId, record.terms.token);
        uint256 day = currentDay();
        outstanding[scope] -= record.terms.amount;
        booked[scope][day] += record.terms.amount;
        record.state = CaseState.Repaid;
        record.outcomeRef = repaymentTxHash;
        record.outcomeCommitment = evidenceBundleHash;
        emit RepaymentCompleted(caseKey, repaymentTxHash, evidenceBundleHash, day);
    }

    /// @notice Records that the buyer received and acknowledged the existing result.
    function completeRetrieval(bytes32 caseKey, bytes32 artifactHash, bytes32 acknowledgementHash) external onlyVerifier {
        CaseRecord storage record = existing(caseKey);
        if (record.state != CaseState.ReservedRetrieve) revert WrongState(record.state);
        if (artifactHash == bytes32(0) || acknowledgementHash == bytes32(0)) revert InvalidTerms();
        record.state = CaseState.Recovered;
        record.outcomeRef = artifactHash;
        record.outcomeCommitment = acknowledgementHash;
        emit RetrievalCompleted(caseKey, artifactHash, acknowledgementHash);
    }

    // ---------------------------------------------------------------------------------------------
    // Standing policies

    /// @notice Activates a new immutable policy version for the caller's scope. A previously active
    ///         version for the same scope is replaced. Exposure belongs to the scope, so replacing a
    ///         version never resets what is booked or outstanding.
    function activatePolicy(PolicyTerms calldata terms) external returns (uint64 authorizationId) {
        if (
            terms.delegate == address(0) || terms.signer == address(0) || terms.token == address(0) || terms.paymentChainId == 0
                || terms.servicePolicyHash == bytes32(0) || terms.eligibilityRulesHash == bytes32(0) || terms.maxPerCase == 0
                || terms.maxPerCase > terms.dailyLimit || terms.validUntil <= terms.validFrom
        ) revert InvalidTerms();
        if (terms.validUntil <= block.timestamp) revert DeadlineNotInFuture();

        bytes32 scope = scopeOf(msg.sender, terms.paymentChainId, terms.token);
        uint64 replaced = activePolicyOf[scope];
        if (replaced != 0) policies[replaced].status = PolicyStatus.Replaced;

        authorizationId = ++policyCount;
        policies[authorizationId] = Policy({seller: msg.sender, terms: terms, status: PolicyStatus.Active});
        activePolicyOf[scope] = authorizationId;
        emit PolicyActivated(authorizationId, msg.sender, scope, terms, replaced);
    }

    /// @notice Stops future automatic reservations under this version until the seller resumes it.
    function pausePolicy(uint64 authorizationId) external {
        Policy storage policy = ownPolicy(authorizationId);
        if (policy.status != PolicyStatus.Active) revert PolicyNotActive(policy.status);
        policy.status = PolicyStatus.Paused;
        emit PolicyPaused(authorizationId);
    }

    function resumePolicy(uint64 authorizationId) external {
        Policy storage policy = ownPolicy(authorizationId);
        if (policy.status != PolicyStatus.Paused) revert PolicyNotActive(policy.status);
        if (block.timestamp >= policy.terms.validUntil) revert PolicyOutsideValidity();
        policy.status = PolicyStatus.Active;
        emit PolicyResumed(authorizationId);
    }

    /// @notice Ends this version permanently. Reservations already made under it stay reserved.
    function revokePolicy(uint64 authorizationId) external {
        Policy storage policy = ownPolicy(authorizationId);
        if (policy.status != PolicyStatus.Active && policy.status != PolicyStatus.Paused) revert PolicyNotActive(policy.status);
        policy.status = PolicyStatus.Revoked;
        bytes32 scope = scopeOf(policy.seller, policy.terms.paymentChainId, policy.terms.token);
        if (activePolicyOf[scope] == authorizationId) activePolicyOf[scope] = 0;
        emit PolicyRevoked(authorizationId);
    }

    // ---------------------------------------------------------------------------------------------
    // Reads

    function getCase(bytes32 caseKey) external view returns (CaseRecord memory) {
        return cases[caseKey];
    }

    function getPolicy(uint64 authorizationId) external view returns (Policy memory) {
        return policies[authorizationId];
    }

    /// @notice Booked amount for `day` and the scope's total outstanding exposure.
    function getBudget(bytes32 scope, uint256 day) external view returns (uint256 bookedOnDay, uint256 outstandingNow) {
        return (booked[scope][day], outstanding[scope]);
    }

    function currentDay() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function scopeOf(address seller, uint64 paymentChainId, address token) public pure returns (bytes32) {
        return keccak256(abi.encode(seller, paymentChainId, token));
    }

    function referenceKey(uint64 paymentChainId, bytes32 txHash) public pure returns (bytes32) {
        return keccak256(abi.encode(paymentChainId, txHash));
    }

    // ---------------------------------------------------------------------------------------------
    // Internal

    function existing(bytes32 caseKey) private view returns (CaseRecord storage record) {
        record = cases[caseKey];
        if (record.state == CaseState.None) revert CaseNotFound();
    }

    function openRepayment(bytes32 caseKey) private view returns (CaseRecord storage record) {
        record = existing(caseKey);
        if (record.state != CaseState.Open) revert WrongState(record.state);
        if (record.terms.kind != ActionKind.Repay) revert WrongKind();
        if (block.timestamp >= record.terms.deadline) revert DeadlinePassed();
    }

    function ownPolicy(uint64 authorizationId) private view returns (Policy storage policy) {
        policy = policies[authorizationId];
        if (policy.status == PolicyStatus.None) revert PolicyNotFound();
        if (msg.sender != policy.seller) revert OnlySeller();
    }
}
