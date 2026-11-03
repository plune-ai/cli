# junit-folder-surefire

Written by hand to Maven Surefire's XML report schema (maven-surefire-plugin 3.x, JUnit Platform provider), not
taken from a live run. The live Surefire folder is `junit-folder-surefire-3.5.6`; this one stays for what that run
does not have: a test that prints `[[ATTACHMENT|artifacts/cart-total.txt]]` to `system-out`, with the file below the
folder, and an `error` beside a `failure` and a `skipped`. Its test names keep JUnit 5's parentheses
(`addsAnItem()`), as Gradle writes them; the live Surefire 3.5.6 run writes them without (`addsAnItem`), so the
keys of this folder are Gradle-shaped, not what Maven gives.
