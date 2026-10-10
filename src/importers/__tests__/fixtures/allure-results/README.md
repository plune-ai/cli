# allure-results fixtures

Each folder was written by the adapter it is named after, running the same four tests (`adds an item` with a
picture on a step and a JSON on the test, `total is wrong` failing with a text on its step, `coupon` skipped,
`boom` throwing). pytest adds a fixture that attaches a log from a step, and a parametrised test.
All six were built live on 2026-10-10, none written by hand:

| folder       | adapter                                  | notes                                                              |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| `pytest`     | allure-pytest 2.16.2 (pytest 9.1.1)      |                                                                    |
| `junit5`     | allure-junit5 2.29.0, JUnit 5.10.2, Surefire 3.2.5, JDK 11 | writes a container per class and per test               |
| `playwright` | allure-playwright 3.13.0 (Playwright 1.64.0) | no containers                                                  |
| `vitest`     | allure-vitest 3.13.0 (Vitest 5.0.3)      | writes no result for a skipped test, so three results             |
| `cypress`    | allure-cypress 3.13.0 (Cypress 16.1.1)       | a pending test is `skipped`                                        |
| `jest`       | allure-jest 3.13.0 (Jest 30.5.2)                     |                                                                    |

Changed after the run, and nothing else: the machine's folder in a trace became `/work`, and the host name
`ci-host`. Attachment contents are the small test strings, not real screenshots.
