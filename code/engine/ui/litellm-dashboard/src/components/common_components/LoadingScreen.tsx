import { cx } from "@/lib/cva.config";
import { UiLoadingSpinner } from "../ui/ui-loading-spinner";
import { PRODUCT_WORDMARK_SRC } from "@/lib/brand";
import Image from "next/image";

export default function LoadingScreen() {
  return (
    <div className={cx("h-screen", "flex items-center justify-center gap-4")}>
      <div className="border-r border-r-gray-200 py-2 pr-4">
        <Image
          src={PRODUCT_WORDMARK_SRC}
          alt="Anonymice"
          width={1080}
          height={210}
          className="h-7 w-auto object-contain dark:brightness-0 dark:invert"
        />
      </div>

      <div className="flex items-center justify-center gap-2">
        <UiLoadingSpinner className="size-4" />
        <span className="text-muted-foreground text-sm">Loading...</span>
      </div>
    </div>
  );
}
