# junit-folder-surefire-3.5.6

`target/surefire-reports` from a live run of report-action's Smoke 41614390691 (plune-ai/report-action):
maven-surefire-plugin 3.5.6, JUnit 5.14.4, temurin 21, ubuntu. Copied as the job left it, nothing changed:
`TEST-cart.CartTest.xml`, `TEST-cart.PriceTest.xml` and Surefire's text summaries `cart.CartTest.txt`,
`cart.PriceTest.txt`. The JVM properties in `<properties>` are the GitHub runner's.

What the format says, as these files show it: the test names have no brackets (`addsAnItem`), so the key is
`cart.CartTest#addsAnItem`; `<testsuite>` has no `timestamp`, so a test's span ends when the import reads the report
(plune-ai/plune#2310); no test printed to `system-out`, so there is no attachment marker here — that case is the
hand-written `junit-folder-surefire`.
