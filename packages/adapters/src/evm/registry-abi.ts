// The RecoveryRegistry ABI, copied from the Foundry build of contracts/src/RecoveryRegistry.sol.
// A test compares it with contracts/out so the two cannot drift apart.
export const RECOVERY_REGISTRY_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "verifier_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "activatePolicy",
    "inputs": [
      {
        "name": "terms",
        "type": "tuple",
        "internalType": "struct RecoveryRegistry.PolicyTerms",
        "components": [
          {
            "name": "delegate",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "signer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "paymentChainId",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "servicePolicyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "eligibilityRulesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "maxPerCase",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "dailyLimit",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "validFrom",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "authorizationId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "activePolicyOf",
    "inputs": [
      {
        "name": "scope",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "booked",
    "inputs": [
      {
        "name": "scope",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "day",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "completeRepayment",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "repaymentTxHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "evidenceBundleHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "completeRetrieval",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "artifactHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "acknowledgementHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "currentDay",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getBudget",
    "inputs": [
      {
        "name": "scope",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "day",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "bookedOnDay",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "outstandingNow",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getCase",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct RecoveryRegistry.CaseRecord",
        "components": [
          {
            "name": "terms",
            "type": "tuple",
            "internalType": "struct RecoveryRegistry.CaseTerms",
            "components": [
              {
                "name": "buyer",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "seller",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "token",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "amount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "paymentChainId",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "originalTxHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "policyHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "eligibilityRulesHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "autoEligible",
                "type": "bool",
                "internalType": "bool"
              },
              {
                "name": "actionDigest",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "evidenceDigest",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "kind",
                "type": "uint8",
                "internalType": "enum RecoveryRegistry.ActionKind"
              },
              {
                "name": "deadline",
                "type": "uint64",
                "internalType": "uint64"
              }
            ]
          },
          {
            "name": "state",
            "type": "uint8",
            "internalType": "enum RecoveryRegistry.CaseState"
          },
          {
            "name": "mode",
            "type": "uint8",
            "internalType": "enum RecoveryRegistry.ReservationMode"
          },
          {
            "name": "authorizationId",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "outcomeRef",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "outcomeCommitment",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPolicy",
    "inputs": [
      {
        "name": "authorizationId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct RecoveryRegistry.Policy",
        "components": [
          {
            "name": "seller",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "terms",
            "type": "tuple",
            "internalType": "struct RecoveryRegistry.PolicyTerms",
            "components": [
              {
                "name": "delegate",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "signer",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "token",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "paymentChainId",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "servicePolicyHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "eligibilityRulesHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "maxPerCase",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "dailyLimit",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "validFrom",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "validUntil",
                "type": "uint64",
                "internalType": "uint64"
              }
            ]
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum RecoveryRegistry.PolicyStatus"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "outstanding",
    "inputs": [
      {
        "name": "scope",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pausePolicy",
    "inputs": [
      {
        "name": "authorizationId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "policyCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "referenceKey",
    "inputs": [
      {
        "name": "paymentChainId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "txHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "referenceUsed",
    "inputs": [
      {
        "name": "refKey",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "registerCase",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "terms",
        "type": "tuple",
        "internalType": "struct RecoveryRegistry.CaseTerms",
        "components": [
          {
            "name": "buyer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "seller",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "paymentChainId",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "originalTxHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "policyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "eligibilityRulesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "autoEligible",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "actionDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidenceDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum RecoveryRegistry.ActionKind"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "reserveRepayment",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "reserveRepaymentUnderPolicy",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "authorizationId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "reserveRetrieval",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "resumePolicy",
    "inputs": [
      {
        "name": "authorizationId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokePolicy",
    "inputs": [
      {
        "name": "authorizationId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "scopeOf",
    "inputs": [
      {
        "name": "seller",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "paymentChainId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "verifier",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "CaseRegistered",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "terms",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct RecoveryRegistry.CaseTerms",
        "components": [
          {
            "name": "buyer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "seller",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "paymentChainId",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "originalTxHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "policyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "eligibilityRulesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "autoEligible",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "actionDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidenceDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum RecoveryRegistry.ActionKind"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyActivated",
    "inputs": [
      {
        "name": "authorizationId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "scope",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "terms",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct RecoveryRegistry.PolicyTerms",
        "components": [
          {
            "name": "delegate",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "signer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "paymentChainId",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "servicePolicyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "eligibilityRulesHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "maxPerCase",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "dailyLimit",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "validFrom",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "replacedAuthorizationId",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyPaused",
    "inputs": [
      {
        "name": "authorizationId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyResumed",
    "inputs": [
      {
        "name": "authorizationId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyRevoked",
    "inputs": [
      {
        "name": "authorizationId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RepaymentCompleted",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "repaymentTxHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "evidenceBundleHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "day",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RepaymentReserved",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "mode",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum RecoveryRegistry.ReservationMode"
      },
      {
        "name": "authorizationId",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "scope",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RetrievalCompleted",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "artifactHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "acknowledgementHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RetrievalReserved",
    "inputs": [
      {
        "name": "caseKey",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "CaseExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CaseNotFound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DeadlineNotInFuture",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DeadlinePassed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidCaseKey",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidTerms",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAutoEligible",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyDelegate",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlySeller",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyVerifier",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OverDailyLimit",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OverPerCaseLimit",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyNotActive",
    "inputs": [
      {
        "name": "status",
        "type": "uint8",
        "internalType": "enum RecoveryRegistry.PolicyStatus"
      }
    ]
  },
  {
    "type": "error",
    "name": "PolicyNotCurrent",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyNotFound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyOutsideValidity",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReferenceAlreadyUsed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongKind",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongState",
    "inputs": [
      {
        "name": "state",
        "type": "uint8",
        "internalType": "enum RecoveryRegistry.CaseState"
      }
    ]
  }
] as const;
