import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type DefaultValues, type FieldValues, type Path, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import { ApiError } from "../../lib/api";

/**
 * react-hook-form + the shared Zod request schema from @arms/contracts (same Japanese messages as the API).
 * `applyServerErrors` maps API field_errors (e.g. "email": "このメールアドレスは既に登録されています。") onto fields.
 */
export function useApiForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  defaultValues: DefaultValues<z.input<S>>,
): UseFormReturn<z.input<S>, unknown, z.output<S>> & { applyServerErrors(error: unknown): boolean } {
  const form = useForm<z.input<S>, unknown, z.output<S>>({
    resolver: zodResolver(schema as never) as never,
    defaultValues,
    mode: "onBlur",
  });
  const applyServerErrors = (error: unknown): boolean => {
    if (!(error instanceof ApiError)) return false;
    const entries = Object.entries(error.fieldErrors);
    for (const [field, message] of entries) form.setError(field as Path<z.input<S>>, { type: "server", message });
    if (error.code === "EMAIL_TAKEN") form.setError("email" as Path<z.input<S>>, { type: "server", message: error.messageJa });
    if (error.code === "EMPLOYEE_NUMBER_TAKEN") form.setError("employee_number" as Path<z.input<S>>, { type: "server", message: error.messageJa });
    if (error.code === "TEACHER_NUMBER_TAKEN") form.setError("teacher_number" as Path<z.input<S>>, { type: "server", message: error.messageJa });
    return entries.length > 0;
  };
  return Object.assign(form, { applyServerErrors });
}
