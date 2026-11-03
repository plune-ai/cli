# junit-folder-gradle-9.8.1

`build/test-results/test` from a live run of report-action's Smoke 41611972921 (plune-ai/report-action):
Gradle 9.8.1, JUnit 5.14.4, ubuntu. Copied as the job left it, nothing changed: `TEST-cart.CartTest.xml` and
Gradle's `binary/` folder (`output-events.bin`, `results-generic.bin`).

What the format says, as this file shows it: the test names carry their brackets (`addsAnItem()`), so the key is
`cart.CartTest#addsAnItem()`; `system-out` and `system-err` are written once per suite, empty; one test failed,
one was skipped, one passed. This README is the folder's only non-XML file at the top, and is not read either.
