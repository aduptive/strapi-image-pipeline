import * as React from 'react'
import { TextInput, Switch, Flex, Typography } from '@strapi/design-system'
import { useFetchClient, useRBAC } from '@strapi/helper-plugin'
import { Settings, permissions, register } from './Settings'
const NumberField = ({ name, label, value, onChange, ...props }: any) =>
  <TextInput {...props} name={name} label={label} type="number" value={String(value)} onChange={(e: any) => onChange(e.target.value)} />
const ToggleField = ({ name, label, value, onChange, disabled }: any) =>
  <Flex gap={3}><Switch name={name} aria-label={label} selected={value} disabled={disabled} onChange={() => onChange(!value)} /><Typography>{label}</Typography></Flex>
function usePermissions() {
  const { allowedActions, isLoading }: any = useRBAC(permissions)
  return { canRead: allowedActions.canRead, canUpdate: allowedActions.canUpdate, isLoading }
}
const Page = () => <Settings useClient={useFetchClient} usePermissions={usePermissions} NumberField={NumberField} ToggleField={ToggleField} />
export default { register(app: any) { register(app, Page, '/settings/image-pipeline') } }
