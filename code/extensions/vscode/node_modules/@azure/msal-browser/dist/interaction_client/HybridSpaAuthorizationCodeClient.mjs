/*! @azure/msal-browser v5.19.0 2026-08-18 */
'use strict';
import { AuthorizationCodeClient } from '@azure/msal-common/browser';

/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
class HybridSpaAuthorizationCodeClient extends AuthorizationCodeClient {
    constructor(config, performanceClient) {
        super(config, performanceClient);
        this.includeRedirectUri = false;
    }
}

export { HybridSpaAuthorizationCodeClient };
//# sourceMappingURL=HybridSpaAuthorizationCodeClient.mjs.map
