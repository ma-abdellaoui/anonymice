import React from "react";
import Image from "next/image";
import { CircleAlert, Info } from "lucide-react";
import { z } from "zod/v4";
import { Alert, AlertDescription, AlertTitle } from "@/components/shared/Alert";
import { PasswordInput } from "@/components/shared/PasswordInput";
import { Field, FieldLabel, FieldGroup } from "@/components/shared/form/field";
import { FormField } from "@/components/shared/form/FormField";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";
import { useZodForm } from "@/lib/forms/useZodForm";
import { PRODUCT_WORDMARK_SRC } from "@/lib/brand";

type OnboardingFormBodyProps = {
  variant: "signup" | "reset_password";
  userEmail: string;
  isPending: boolean;
  claimError: string | null;
  onSubmit: (values: { password: string }) => void;
};

const onboardingSchema = z.object({
  password: z.string().min(1, "password required to sign up"),
});

type OnboardingFormValues = z.infer<typeof onboardingSchema>;

export function OnboardingFormBody({ variant, userEmail, isPending, claimError, onSubmit }: OnboardingFormBodyProps) {
  const form = useZodForm(onboardingSchema, { defaultValues: { password: "" } });
  const emailFieldId = React.useId();
  const isResetPassword = variant === "reset_password";
  const actionLabel = isResetPassword ? "Reset Password" : "Sign Up";

  const handleSubmit = (values: OnboardingFormValues) => onSubmit({ password: values.password });

  return (
    <div className="mx-auto w-full max-w-md mt-10">
      <Card>
        <CardContent>
          <Image
            src={PRODUCT_WORDMARK_SRC}
            alt="Anonymice"
            width={1080}
            height={210}
            className="mx-auto mb-5 h-8 w-auto object-contain dark:brightness-0 dark:invert"
          />
          <h3 className="text-2xl font-semibold text-foreground">{actionLabel}</h3>
          <p className="text-sm text-foreground">
            {isResetPassword
              ? "Reset your password to access Admin UI."
              : "Claim your user account to login to Admin UI."}
          </p>

          {variant === "signup" && (
            <Alert className="mt-4" variant="info">
              <Info />
              <AlertTitle>SSO</AlertTitle>
              <AlertDescription>
                <span>SSO is under the Enterprise Tier. Contact your administrator for access.</span>
              </AlertDescription>
            </Alert>
          )}

          <form className="mt-10 mb-5" onSubmit={form.handleSubmit(handleSubmit)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={emailFieldId}>Email Address</FieldLabel>
                <Input id={emailFieldId} type="email" value={userEmail} readOnly disabled />
              </Field>

              <FormField
                control={form.control}
                name="password"
                label="Password"
                description={isResetPassword ? "Enter your new password" : "Create a password for your account"}
              >
                {({ ref, ...field }) => <PasswordInput {...field} ref={ref} />}
              </FormField>
            </FieldGroup>

            {claimError && (
              <Alert variant="error" className="mt-6 mb-4">
                <CircleAlert />
                <AlertTitle>{claimError}</AlertTitle>
              </Alert>
            )}

            <div className="mt-10">
              <Button type="submit" variant="outline" disabled={isPending}>
                {isPending && <UiLoadingSpinner className="size-4" role="img" aria-label="loading" />}
                {actionLabel}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
