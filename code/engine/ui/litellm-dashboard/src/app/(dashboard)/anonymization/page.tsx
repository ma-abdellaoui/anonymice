"use client";

import AnonymizationPanel from "./_components/AnonymizationPanel";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";

export default function Anonymization() {
  const { accessToken, userRole, userId } = useAuthorized();
  return <AnonymizationPanel accessToken={accessToken} userRole={userRole} userId={userId} />;
}
