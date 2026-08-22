"use client";

import PiiActivityView from "./_components/PiiActivityView";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";

export default function PiiActivity() {
  const { accessToken } = useAuthorized();
  return <PiiActivityView accessToken={accessToken} />;
}
