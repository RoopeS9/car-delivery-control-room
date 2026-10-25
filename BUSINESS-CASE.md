# Road Desk: a car issue takes €2.5–6 of operator time instead of €15–28, plus about €0.12 of AI

| Per incident case (breakdown, new date, silent driver) | Today: a person does it all | With Road Desk |
|---|---|---|
| Operator time per case | 30–45 min | 5–10 min: read the card, decide, make the one call a person must make |
| Cases per operator-hour | 1.3–2 | 6–12 |
| Operator cost per case (€0.50–0.62/min) | €15–28 | €2.5–6 |
| AI cost per case (measured) | – | €0.04–0.21, mean €0.12 |
| Agent work before a person looks (measured) | – | 45 s–3 min; first answer to the driver in 6–33 s |
| Month at ~2,100 deliveries (≈310 incidents + 2,100 routine questions) | ≈456 operator-h ≈ €17k | ≈56 operator-h ≈ €2.1k + €0.6k tech |

- **≈ €14k a month (84%) of first-line work saved**, about 3 FTE of hours. Range 67–90%: at 10% incidents and 30→10 min it is ≈ €5.6k; at 20% and 45→5 min it is ≈ €22k.
- **Break-even comes early:** the tech costs €0.6k a month (agent €0.16k, calls and speech €0.36k, hosting €0.1k) and pays for itself once it saves ~20 operator-hours a month. Even the costliest traced incident (€0.21 of AI) equals ~25 s of operator time.
- **Peaks:** five incidents in one evening hour (say a cancelled sailing) are 2.5–3.75 h of work today, so 3–4 people, or the last driver waits ~3 h. With Road Desk one person clears them in 25–50 min, and each driver hears from the agent within a minute.
- **The person stays.** Every booking, customer message and drive-on clearance waits for a person, so one seat is always on duty (24/7 ≈ 5.4 FTE ≈ €27k a month either way). The hours saved become cash as staff not added for daytime load, peaks and growth: the same seat handles about 5× the cases per hour.
- **Caveats:** handling times are estimates, not measured at Bahn. Costs come from 7 traced stories on synthetic data. A model turn can take up to 2 min at busy hours. A wrong draft is stopped at the gate but still costs operator minutes.

<sub>€20/h gross + 19.9% statutory employer costs (2026) + paid leave and holiday bonus (×1.25 per worked hour) = €30/h by day, €37.5/h averaged over 24/7 with shift premiums. 15% of deliveries have an incident, one routine question per delivery. 1 USD = €0.89.</sub>

---

## Assumptions and sources

- **Measured, AI cost:** `usage.cost_usd`, as billed by OpenRouter, in the 18 agent runs under `starter/traces/e2e-roles-2026-10-25T01-24/` (DeepSeek v4 pro agent, v4 flash safety screen), plus a 5-run rerun of story B. Incidents A, B, B rerun, F cost $0.19, $0.24, $0.05, $0.04. Routine C, D, G and a customer email cost $0.004–0.033 per case. The monthly figure uses the high end ($0.24 per incident, $0.05 per routine question).
- **Measured, agent time:** each run's start to its last tool call on the simulated clock (a lower bound). RUN-SHEET.md gives 20–60 s per turn.
- **Cross-check:** the night of testing cost about $7.2 (OpenRouter key went from $2.88 to $10.08, PROCESS.md) over ~70–120 story runs plus calls and checks. That is $0.06–0.10 per story, an upper bound because tests repeat work.
- **Model prices:** the traces were billed at full provider rates (about $1.3–1.9 per million input tokens). OpenRouter lists v4 pro at $0.21–1.91/M input and $0.42–3.83/M output across providers, the cheapest at a discount, so cost per case could drop several times. Sources: [v4 pro](https://openrouter.ai/deepseek/deepseek-v4-pro), [v4 flash](https://openrouter.ai/deepseek/deepseek-v4-flash), [v4 pro endpoint prices](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-pro/endpoints).
- **Calls:** one full delivery run (3 calls plus reasoning, simulated counterpart included) cost $0.105 (`dossier/data/out/runs/`). Speech is ElevenLabs at ~$0.04 per 1,000 characters (PROCESS.md), ~$0.09 per delivery. Telephony is not included.
- **Hosting (assumed):** €50–150 a month for one small VM (Next.js app and dossier service) and a small managed Postgres. €100 used.
- **Volume:** 25,000 cars a year (brief) ≈ 2,100 a month. Assumed: 15% of deliveries (10–20%) need incident handling, there is one routine question (driver, desk or customer) per delivery, and 1 in 3 routine questions needs a card. In the traces, C needed a card and D and G were closed by the agent.
- **Handling times (assumed):** today an incident takes 30–45 min (read, look up the order, call the driver, find a tow, workshop or ferry, call the dealer, update the driver, write notes, chase) and a routine question 5–10 min. With Road Desk an incident takes 5–10 min and a routine card 1–2 min.
- **Employer costs 2026:** TyEL employer average 17.10%, health insurance 1.91%, unemployment 0.31% (1.23% above €2.5M payroll), accident 0.51%, group life 0.06% ([ETK](https://www.etk.fi/wp-content/uploads/2026/01/lakisaateiset-sosiaalivakuutusmaksut-suomessa-2026-suomi-1.pdf), [Statistics Finland](https://media.stat.fi/A7H6ohk0S8qafyCM4bfDaz/cmnrl8pep1mb807w1rc26gpmx)). Paid leave: 1,635 worked hours out of 1,950 paid (25 holiday days, 9 public holidays, 8 sick days), plus a holiday bonus of 50% of holiday pay.
- **Shift premiums:** Sunday work +100% ([Working Hours Act 872/2019](https://www.finlex.fi/fi/lainsaadanto/2019/872)). Evenings +15% and nights +30% are assumed (typical collective-agreement levels), which averages +25% over a 24/7 week. A 24/7 seat is 8,760 h ÷ 1,635 h ≈ 5.4 FTE.
- **Exchange rate:** ECB reference rate on 23 Oct 2026, 1 EUR = 1.1193 USD ([ECB](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)).
