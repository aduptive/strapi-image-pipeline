import * as React from 'react'
import { Field, TextInput, Switch, Flex, Typography } from '@strapi/design-system'
import { useFetchClient, useRBAC } from '@strapi/strapi/admin'
import { Settings, permissions, register } from './Settings'
const NumberField = ({ name, label, value, onChange, ...props }: any) =>
  <Field.Root name={name}><Field.Label>{label}</Field.Label><TextInput {...props} type="number" value={String(value)} onChange={(e: any) => onChange(e.target.value)} /></Field.Root>
const ToggleField = ({ name, label, value, onChange, disabled }: any) =>
  <Flex gap={3}><Switch name={name} aria-label={label} checked={value} disabled={disabled} onCheckedChange={onChange} /><Typography>{label}</Typography></Flex>
function usePermissions() {
  const { allowedActions, isLoading }: any = useRBAC(permissions)
  return { canRead: allowedActions.canRead, canUpdate: allowedActions.canUpdate, isLoading }
}
const Page = () => <Settings useClient={useFetchClient} usePermissions={usePermissions} NumberField={NumberField} ToggleField={ToggleField} />
export default { register(app: any) { register(app, Page) } }
