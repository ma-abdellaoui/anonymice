# Customer record

Anna Meier — IBAN CH93 0076 2011 6238 5295 7
Contact: anna.meier+billing@Example.ORG
Card on file: 4242 4242 4242 4242
AHV: 756.1234.5678.97

<!--
Everything above except the NAME is highlighted light-red by the rule pass and
tokenized by "Anonymice: Tokenize All in File".

"Anna Meier" is not, and that is the point: rules cover checksummed classes and
vendor-prefixed secrets. PERSON, ADDR and ORG need the detection backend, which
is not wired yet (SPEC §5.1). Select the name and use "Tokenize Selection" to do
it by hand.
-->
