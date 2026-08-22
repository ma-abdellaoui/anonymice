Types of resources:
NATIVE
TRUSTED
Every other resource is UNTRUSTED.

NATIVE - we leave values as is only highlighting sensitive data.
TRUSTED - on sensitive paste we replace sensitive data containing element with clone hiding the original.
    highlight sensitive data. propagate data
        (if input to the original with sensitive data replaced by token in original input and real value in clone)
UNTRUSTED - show token as-is on paste. don't allow actual sensitive data into DOM.


There are list of trusted resources. Everything else is not trusted.
Browser extension looks at the page on trusted resource and identifies sensitive data.
Browser extension let's user know if there are sensitive data on the page.
Browser extension colors sensitive data light-red.
Sensitive data is saved to key-value storage where key is a token like PERSON-xxx.
User copies sensitive data whole.
Cliboard hijacked. Instead of sensitive data user has token (key) instead of value in his clipboard.
User copies sensitive data partially.
New key-value created as a child of main token.
Clipboard hijacted. Instead of partially copied sensitive data user has token (key) instead of partial value.
User inserts token (key) to an TRUSTED resource
Token is checked with key-value storage to get the value.
Replace input element with ours so user sees the actual value 

