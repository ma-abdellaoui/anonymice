/*! @azure/msal-browser v5.19.0 2026-08-18 */
'use strict';
import { CustomAuthError } from './CustomAuthError.mjs';

/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
class NoCachedAccountFoundError extends CustomAuthError {
    constructor(correlationId) {
        super("no_cached_account_found", "No account found in the cache", correlationId);
        Object.setPrototypeOf(this, NoCachedAccountFoundError.prototype);
    }
}

export { NoCachedAccountFoundError };
//# sourceMappingURL=NoCachedAccountFoundError.mjs.map
