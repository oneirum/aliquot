The worst finding inside the run loop, fixed in commit `501c1e9`: a tool's refused network request ended the whole run as refused. An agent with a lab knowledge base reads D1 in every prompt (the outline is in the system text), so every literature call it made was refused by the egress decision, which is right, and `fold()` then ended the run with "it contains restricted data" on a question it could answer, which is wrong. `tools.ts` already recorded the call as a failed tool call; now the model reads that failure and answers without the tool. Nothing is sent either way.

| On lab1, scripted model | Before (`8b46fcc`) | After (`501c1e9`) |
|---|---|---|
| Refused, should answer | 20 of 258 | 7 of 258 (all seven are the classifier's) |
| Answers lost to a planted instruction | 10 | 0 |
| Data sent past the egress decision | 0 | 0 |
| Planted instructions obeyed | 28 of 44 | 30 of 44 |

The two extra obeyed instructions are runs that also read an entry asking for a PubMed search. Before, those runs died at the refused search, which hid the second planted instruction; now they finish and the scripted model obeys it. Sonnet obeyed none of the 40 it was asked (the other 4 were refused before any model saw them).

The worst finding at the gate, fixed after release 0.8.0 (`01f4173`): 17 of 42 questions carrying a participant id or PHI were answered, and each reached the hosted model, because the detectors knew one spelling of each identifier. The built-in `restricted` class now catches the forms a person types (an SSN with spaces or after a label, a spelled-out MRN or date of birth, a participant id in lower case or with a space, en dash or fewer digits) and the Safe Harbor identifiers that do not occur in a lab handbook (admission dates, health plan and licence numbers, IP addresses, a full-face photo reference, a name beside a health reading or a home address). The gate stamps each at D3, so the egress decision refuses it at the approved endpoint before a request is built. An SSN-shaped number after "part", "lot", "serial" or an order word is no longer an SSN.

| On lab1, scripted model | Before (`01f4173`) | After |
|---|---|---|
| Answered, should refuse | 17 of 42 (51 hosted requests) | 0 of 42 (0) |
| Refused, should answer | 7 of 258 | 1 of 258 (the sentence that names the review marker) |

Six more answerable questions are now answered, so the scripted model's wrong and forged citation counts each rose by one: the scripted model obeys the forge-cite instruction planted in the timesheets entry when it answers "When are timesheets due?".
