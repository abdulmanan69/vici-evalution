/**
 * Built-in QA scorecards: the fronter transfer form (TRA) and the two closer
 * forms (Unclosed / Closed, identical by design). Every company gets them
 * at boot and on creation; a manager can bring back any that were archived
 * from QA forms -> "Load default forms" (POST /qa/forms/load-defaults).
 * Editing a loaded copy never touches these definitions.
 *
 * Generated from the published versions; keep question ids stable so the
 * evaluations report columns stay aligned across companies.
 */
export interface DefaultForm {
  /** stable identifier, independent of the display name */
  key: string;
  name: string;
  description: string | null;
  target: 'fronter' | 'closer' | 'any';
  queue: 'transfer' | 'unclosed' | 'closed' | null;
  passThreshold: number;
  /** validated with formDefinitionSchema when loaded */
  schema: unknown;
}

export const DEFAULT_FORMS: DefaultForm[] = [
  {
    key: "tra-fronter",
    name: "TRA - Transfer Call (Fronter)",
    description: "Fronter transfer scorecard - scored out of 100, pass above 65",
    target: "fronter",
    queue: "transfer",
    passThreshold: 66,
    schema: {
      "sections": [
        {
          "id": "scoring",
          "title": "Scoring",
          "questions": [
            {
              "id": "greeting_energy",
              "text": "Greeting / CRO energy",
              "type": "dropdown",
              "weight": 10,
              "options": [
                {
                  "label": "0",
                  "value": "0",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "5",
                  "value": "5",
                  "autoFail": false,
                  "scorePct": 50
                },
                {
                  "label": "10",
                  "value": "10",
                  "autoFail": false,
                  "scorePct": 100
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "communication",
              "text": "Communication",
              "type": "dropdown",
              "weight": 20,
              "options": [
                {
                  "label": "0",
                  "value": "0",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "5",
                  "value": "5",
                  "autoFail": false,
                  "scorePct": 25
                },
                {
                  "label": "10",
                  "value": "10",
                  "autoFail": false,
                  "scorePct": 50
                },
                {
                  "label": "15",
                  "value": "15",
                  "autoFail": false,
                  "scorePct": 75
                },
                {
                  "label": "20",
                  "value": "20",
                  "autoFail": false,
                  "scorePct": 100
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "customer_understanding",
              "text": "Customer Understanding",
              "type": "dropdown",
              "weight": 20,
              "options": [
                {
                  "label": "0",
                  "value": "0",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "5",
                  "value": "5",
                  "autoFail": false,
                  "scorePct": 25
                },
                {
                  "label": "10",
                  "value": "10",
                  "autoFail": false,
                  "scorePct": 50
                },
                {
                  "label": "15",
                  "value": "15",
                  "autoFail": false,
                  "scorePct": 75
                },
                {
                  "label": "20",
                  "value": "20",
                  "autoFail": false,
                  "scorePct": 100
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "qualifying_qs",
              "text": "Qualifying Q's",
              "type": "dropdown",
              "weight": 25,
              "options": [
                {
                  "label": "0",
                  "value": "0",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "5",
                  "value": "5",
                  "autoFail": false,
                  "scorePct": 20
                },
                {
                  "label": "10",
                  "value": "10",
                  "autoFail": false,
                  "scorePct": 40
                },
                {
                  "label": "15",
                  "value": "15",
                  "autoFail": false,
                  "scorePct": 60
                },
                {
                  "label": "25",
                  "value": "25",
                  "autoFail": false,
                  "scorePct": 100
                }
              ],
              "critical": false,
              "helpText": "Top option scores the full 25 (the old form's 25-shows-but-scores-20 bug is fixed here).",
              "required": true
            },
            {
              "id": "misguide",
              "text": "Misguide",
              "type": "dropdown",
              "weight": 10,
              "options": [
                {
                  "label": "0",
                  "value": "0",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "5",
                  "value": "5",
                  "autoFail": false,
                  "scorePct": 50
                },
                {
                  "label": "10",
                  "value": "10",
                  "autoFail": false,
                  "scorePct": 100
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "rebuttals",
              "text": "Use of Rebuttals",
              "type": "dropdown",
              "weight": 15,
              "options": [
                {
                  "label": "0",
                  "value": "0",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "5",
                  "value": "5",
                  "autoFail": false,
                  "scorePct": 33.33
                },
                {
                  "label": "10",
                  "value": "10",
                  "autoFail": false,
                  "scorePct": 66.67
                },
                {
                  "label": "15",
                  "value": "15",
                  "autoFail": false,
                  "scorePct": 100
                }
              ],
              "critical": false,
              "required": true
            }
          ]
        },
        {
          "id": "review",
          "title": "Review",
          "questions": [
            {
              "id": "comments",
              "text": "Comments",
              "type": "text",
              "weight": 0,
              "critical": false,
              "required": false
            },
            {
              "id": "final_status",
              "text": "Final Status (reviewer's verdict)",
              "type": "dropdown",
              "weight": 0,
              "options": [
                {
                  "label": "Pass",
                  "value": "pass",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Fail",
                  "value": "fail",
                  "autoFail": false,
                  "scorePct": 0
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "standard_status",
              "text": "Status (info only)",
              "type": "dropdown",
              "weight": 0,
              "options": [
                {
                  "label": "Standard",
                  "value": "standard",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Below Standard",
                  "value": "below_standard",
                  "autoFail": false,
                  "scorePct": 0
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "rejection_reason",
              "text": "Reason of rejection",
              "type": "text",
              "weight": 0,
              "critical": false,
              "required": false
            }
          ]
        }
      ]
    },
  },
  {
    key: "unclosed-closer",
    name: "Unclosed - Closer Call",
    description: "Closer scorecard for unclosed calls - 5 scales, pass at 90%",
    target: "closer",
    queue: "unclosed",
    passThreshold: 90,
    schema: {
      "sections": [
        {
          "id": "scoring",
          "title": "Scoring",
          "questions": [
            {
              "id": "communication_energy",
              "text": "Communication Energy Level / Tone",
              "type": "rating",
              "weight": 5,
              "critical": false,
              "required": true,
              "scaleMax": 5
            },
            {
              "id": "warranty_knowledge",
              "text": "Warranty Knowledge Clarity to Customer",
              "type": "rating",
              "weight": 5,
              "critical": false,
              "required": true,
              "scaleMax": 5
            },
            {
              "id": "pricing_explanation",
              "text": "Pricing Explanation Effectiveness",
              "type": "rating",
              "weight": 5,
              "critical": false,
              "required": true,
              "scaleMax": 5
            },
            {
              "id": "rebuttal_responsiveness",
              "text": "Rebuttal Responsiveness",
              "type": "rating",
              "weight": 5,
              "critical": false,
              "required": true,
              "scaleMax": 5
            },
            {
              "id": "closing_intent",
              "text": "Closing Intent Strength",
              "type": "rating",
              "weight": 5,
              "critical": false,
              "required": true,
              "scaleMax": 5
            }
          ]
        },
        {
          "id": "outcome",
          "title": "Outcome & Review",
          "questions": [
            {
              "id": "call_outcome",
              "text": "Call Outcome (reporting only)",
              "type": "dropdown",
              "weight": 0,
              "options": [
                {
                  "label": "Pricing Issue",
                  "value": "pricing_issue",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Awaiting",
                  "value": "awaiting",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Technical issue",
                  "value": "technical_issue",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "No conversation",
                  "value": "no_conversation",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Call Back",
                  "value": "call_back",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Customer no longer interested",
                  "value": "no_longer_interested",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "CRO issue",
                  "value": "cro_issue",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Closer issue",
                  "value": "closer_issue",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "NA state",
                  "value": "na_state",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "No Data found",
                  "value": "no_data_found",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Customer issue",
                  "value": "customer_issue",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "No recording found",
                  "value": "no_recording_found",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Customer asked to be on DNC",
                  "value": "dnc_request",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Mechanic Self/Family",
                  "value": "mechanic_self_family",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Abusive Customer",
                  "value": "abusive_customer",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Already Have Warranty",
                  "value": "already_have_warranty",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Spanish Customer",
                  "value": "spanish_customer",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Christmas budget issue",
                  "value": "christmas_budget",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Prices Pitched, CX Not Interested",
                  "value": "pitched_not_interested",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Post Dated",
                  "value": "post_dated",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Sarcastic CX",
                  "value": "sarcastic_cx",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Not Affordable",
                  "value": "not_affordable",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Need to see the docs first",
                  "value": "see_docs_first",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Declined",
                  "value": "declined",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Busy",
                  "value": "busy",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Cx will call us",
                  "value": "cx_will_call",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "NEFW",
                  "value": "nefw",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Cx was not interested",
                  "value": "cx_not_interested",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Dead Air",
                  "value": "dead_air",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Email Required",
                  "value": "email_required",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Language Barrier",
                  "value": "language_barrier",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Skeptical cx",
                  "value": "skeptical_cx",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Will trade the car",
                  "value": "will_trade_car",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Social Security",
                  "value": "social_security",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Cx wants to research",
                  "value": "cx_wants_research",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Cx hungup during conversation",
                  "value": "cx_hungup",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Authorization",
                  "value": "authorization",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Cx wants to think about it",
                  "value": "cx_think_about_it",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Litigator",
                  "value": "litigator",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Callback Date",
                  "value": "callback_date",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Wrong Dispo",
                  "value": "wrong_dispo",
                  "autoFail": false,
                  "scorePct": 0
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "wrong_dispo",
              "text": "Wrong Dispo",
              "type": "dropdown",
              "weight": 0,
              "options": [
                {
                  "label": "Yes",
                  "value": "yes",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "No",
                  "value": "no",
                  "autoFail": false,
                  "scorePct": 0
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "callback_date_field",
              "text": "Callback Date",
              "type": "text",
              "weight": 0,
              "critical": false,
              "helpText": "Optional - YYYY-MM-DD",
              "required": false
            },
            {
              "id": "final_status",
              "text": "Final Status (reviewer's verdict)",
              "type": "dropdown",
              "weight": 0,
              "options": [
                {
                  "label": "Pass",
                  "value": "pass",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Fail",
                  "value": "fail",
                  "autoFail": false,
                  "scorePct": 0
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "additional_comments",
              "text": "Additional Comments",
              "type": "text",
              "weight": 0,
              "critical": false,
              "required": false
            }
          ]
        }
      ]
    },
  },
  {
    key: "closed-closer",
    name: "Closed - Closer Call",
    description: "Closer scorecard for closed calls - same as Unclosed",
    target: "closer",
    queue: "closed",
    passThreshold: 90,
    schema: {
      "sections": [
        {
          "id": "scoring",
          "title": "Scoring",
          "questions": [
            {
              "id": "communication_energy",
              "text": "Communication Energy Level / Tone",
              "type": "rating",
              "weight": 5,
              "critical": false,
              "required": true,
              "scaleMax": 5
            },
            {
              "id": "warranty_knowledge",
              "text": "Warranty Knowledge Clarity to Customer",
              "type": "rating",
              "weight": 5,
              "critical": false,
              "required": true,
              "scaleMax": 5
            },
            {
              "id": "pricing_explanation",
              "text": "Pricing Explanation Effectiveness",
              "type": "rating",
              "weight": 5,
              "critical": false,
              "required": true,
              "scaleMax": 5
            },
            {
              "id": "rebuttal_responsiveness",
              "text": "Rebuttal Responsiveness",
              "type": "rating",
              "weight": 5,
              "critical": false,
              "required": true,
              "scaleMax": 5
            },
            {
              "id": "closing_intent",
              "text": "Closing Intent Strength",
              "type": "rating",
              "weight": 5,
              "critical": false,
              "required": true,
              "scaleMax": 5
            }
          ]
        },
        {
          "id": "outcome",
          "title": "Outcome & Review",
          "questions": [
            {
              "id": "call_outcome",
              "text": "Call Outcome (reporting only)",
              "type": "dropdown",
              "weight": 0,
              "options": [
                {
                  "label": "Pricing Issue",
                  "value": "pricing_issue",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Awaiting",
                  "value": "awaiting",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Technical issue",
                  "value": "technical_issue",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "No conversation",
                  "value": "no_conversation",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Call Back",
                  "value": "call_back",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Customer no longer interested",
                  "value": "no_longer_interested",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "CRO issue",
                  "value": "cro_issue",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Closer issue",
                  "value": "closer_issue",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "NA state",
                  "value": "na_state",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "No Data found",
                  "value": "no_data_found",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Customer issue",
                  "value": "customer_issue",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "No recording found",
                  "value": "no_recording_found",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Customer asked to be on DNC",
                  "value": "dnc_request",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Mechanic Self/Family",
                  "value": "mechanic_self_family",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Abusive Customer",
                  "value": "abusive_customer",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Already Have Warranty",
                  "value": "already_have_warranty",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Spanish Customer",
                  "value": "spanish_customer",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Christmas budget issue",
                  "value": "christmas_budget",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Prices Pitched, CX Not Interested",
                  "value": "pitched_not_interested",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Post Dated",
                  "value": "post_dated",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Sarcastic CX",
                  "value": "sarcastic_cx",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Not Affordable",
                  "value": "not_affordable",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Need to see the docs first",
                  "value": "see_docs_first",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Declined",
                  "value": "declined",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Busy",
                  "value": "busy",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Cx will call us",
                  "value": "cx_will_call",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "NEFW",
                  "value": "nefw",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Cx was not interested",
                  "value": "cx_not_interested",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Dead Air",
                  "value": "dead_air",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Email Required",
                  "value": "email_required",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Language Barrier",
                  "value": "language_barrier",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Skeptical cx",
                  "value": "skeptical_cx",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Will trade the car",
                  "value": "will_trade_car",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Social Security",
                  "value": "social_security",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Cx wants to research",
                  "value": "cx_wants_research",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Cx hungup during conversation",
                  "value": "cx_hungup",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Authorization",
                  "value": "authorization",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Cx wants to think about it",
                  "value": "cx_think_about_it",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Litigator",
                  "value": "litigator",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Callback Date",
                  "value": "callback_date",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Wrong Dispo",
                  "value": "wrong_dispo",
                  "autoFail": false,
                  "scorePct": 0
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "wrong_dispo",
              "text": "Wrong Dispo",
              "type": "dropdown",
              "weight": 0,
              "options": [
                {
                  "label": "Yes",
                  "value": "yes",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "No",
                  "value": "no",
                  "autoFail": false,
                  "scorePct": 0
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "callback_date_field",
              "text": "Callback Date",
              "type": "text",
              "weight": 0,
              "critical": false,
              "helpText": "Optional - YYYY-MM-DD",
              "required": false
            },
            {
              "id": "final_status",
              "text": "Final Status (reviewer's verdict)",
              "type": "dropdown",
              "weight": 0,
              "options": [
                {
                  "label": "Pass",
                  "value": "pass",
                  "autoFail": false,
                  "scorePct": 0
                },
                {
                  "label": "Fail",
                  "value": "fail",
                  "autoFail": false,
                  "scorePct": 0
                }
              ],
              "critical": false,
              "required": true
            },
            {
              "id": "additional_comments",
              "text": "Additional Comments",
              "type": "text",
              "weight": 0,
              "critical": false,
              "required": false
            }
          ]
        }
      ]
    },
  },
];
