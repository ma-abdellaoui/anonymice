import React from "react";

import AnonymizationFlow from "./flow/FlowVisualizer";
import AnonymizationPlayground from "./AnonymizationPlayground";
import AnonymizationSettings from "./AnonymizationSettings";
import PiiAccessNotice from "./access/PiiAccessNotice";
import { usePiiKey } from "./access/usePiiKey";
import VaultBrowser from "./VaultBrowser";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface AnonymizationPanelProps {
  accessToken: string | null;
  userRole: string | null;
  userId: string | null;
}

const AnonymizationPanel: React.FC<AnonymizationPanelProps> = ({ accessToken, userRole, userId }) => {
  const access = usePiiKey(accessToken, userId);

  return (
    <div className="w-full p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-foreground">PII Anonymization</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Detect PII with rule-based and model-based stages, replace it with reversible tokens on the way to the
          provider, and restore it on the way back.
        </p>
      </div>

      <div className="mb-4">
        <PiiAccessNotice access={access} />
      </div>

      <Tabs defaultValue="flow">
        <TabsList>
          <TabsTrigger value="flow">Flow</TabsTrigger>
          <TabsTrigger value="playground">Playground</TabsTrigger>
          <TabsTrigger value="vault">Vault</TabsTrigger>
          <TabsTrigger value="settings">Configuration</TabsTrigger>
        </TabsList>
        <TabsContent value="flow" className="mt-4">
          <AnonymizationFlow accessToken={access.key} userId={userId} userRole={userRole} />
        </TabsContent>
        <TabsContent value="playground" className="mt-4">
          <AnonymizationPlayground accessToken={access.key} />
        </TabsContent>
        <TabsContent value="vault" className="mt-4">
          <VaultBrowser accessToken={access.key} />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <AnonymizationSettings userRole={userRole} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AnonymizationPanel;
