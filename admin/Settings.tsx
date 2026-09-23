import * as React from 'react'
import { Box, Button, Flex, Typography } from '@strapi/design-system'
import { useIntl } from 'react-intl'

const names: Record<string, [string, string]> = {
  enabled: ['Enabled', 'Ativado'], convertToWebp: ['Convert new images to WebP', 'Converter novas imagens para WebP'],
  maxFileSizeMB: ['Maximum file size (MB)', 'Tamanho máximo do arquivo (MB)'],
  maxDimension: ['Maximum dimension (px)', 'Dimensão máxima (px)'], quality: ['Quality (1–100)', 'Qualidade (1–100)'],
  maxMegapixels: ['Maximum megapixels (0 disables)', 'Máximo de megapixels (0 desativa)'],
  sanitizeSvg: ['Sanitize SVG', 'Sanitizar SVG'], optimizeSvg: ['Minify SVG', 'Minificar SVG'],
  addSvgViewBox: ['Add missing SVG viewBox (numeric or px dimensions)', 'Adicionar viewBox ausente (dimensões numéricas ou em px)'],
  responsiveSvg: ['Remove SVG dimensions when viewBox is valid', 'Remover dimensões do SVG quando o viewBox for válido'],
}
const limits: Record<string, [number, number]> = { maxFileSizeMB: [1, 1024], maxDimension: [1, 20000], quality: [1, 100], maxMegapixels: [0, 1000] }
export function Settings({ useClient, usePermissions, NumberField, ToggleField }: any) {
  const { get, put } = useClient()
  const { canRead, canUpdate, isLoading } = usePermissions()
  const language = useIntl().locale.startsWith('pt') ? 1 : 0
  const text = (en: string, pt: string) => language ? pt : en
  const [settings, setSettings] = React.useState<any>(null)
  const [saving, setSaving] = React.useState(false)
  const [status, setStatus] = React.useState('')
  const [failed, setFailed] = React.useState(false)
  React.useEffect(() => {
    if (!canRead || isLoading) return
    let active = true
    get('/image-pipeline/settings').then(({ data }: any) => { if (active) setSettings(data) })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [get, canRead, isLoading])
  const invalid = settings && Object.entries(limits).some(([key, [min, max]]) =>
    settings[key] === '' || !Number.isInteger(Number(settings[key])) || Number(settings[key]) < min || Number(settings[key]) > max)
  const save = async () => {
    if (!settings || invalid || !canUpdate) return
    setSaving(true); setStatus('')
    try {
      const { data } = await put('/image-pipeline/settings', settings)
      setSettings(data); setStatus(text('Settings saved.', 'Configurações salvas.'))
    } catch { setStatus(text('Could not save settings.', 'Não foi possível salvar.')) }
    finally { setSaving(false) }
  }
  return <Box padding={8} background="neutral100"><Flex direction="column" alignItems="stretch" gap={5}>
    <Typography variant="alpha" tag="h1">Image Pipeline</Typography>
    <Typography textColor="neutral600">{text('Settings apply to future uploads. Existing assets are unchanged.', 'As configurações se aplicam aos próximos uploads. Arquivos existentes não são alterados.')}</Typography>
    {isLoading ? <Typography>…</Typography> : !canRead ? <Typography role="alert">{text('Access denied.', 'Acesso negado.')}</Typography> : failed ?
      <Typography role="alert">{text('Could not load settings. Reload to try again.', 'Não foi possível carregar. Recarregue para tentar novamente.')}</Typography> : !settings ?
        <Typography>{text('Loading…', 'Carregando…')}</Typography> : <Box padding={6} background="neutral0" hasRadius>
          <Flex direction="column" alignItems="stretch" gap={5}>
            {Object.entries(names).map(([key, labels]) => {
              const Control = limits[key] ? NumberField : ToggleField
              return <Control key={key} name={key} label={labels[language]} value={settings[key]} disabled={!canUpdate || saving}
                min={limits[key]?.[0]} max={limits[key]?.[1]}
                onChange={(value: any) => setSettings((current: any) => ({ ...current, [key]: value }))} />
            })}
            <Typography textColor="neutral600">{text('SVG viewBox uses the declared width and height with origin 0,0. Percentages, relative units and invalid values are left unchanged; artwork bounds are not calculated.', 'O viewBox usa a largura e altura declaradas com origem 0,0. Porcentagens, unidades relativas e valores inválidos são mantidos; os limites da arte não são calculados.')}</Typography>
            {invalid && <Typography role="alert" textColor="danger600">{text('Check the numeric limits.', 'Verifique os limites numéricos.')}</Typography>}
            <Button onClick={save} disabled={!canUpdate || invalid} loading={saving} data-testid="save-image-settings">{text('Save', 'Salvar')}</Button>
            <Typography role="status">{status}</Typography>
          </Flex>
        </Box>}
  </Flex></Box>
}
export const permissions = { read: [{ action: 'plugin::image-pipeline.read', subject: null }], update: [{ action: 'plugin::image-pipeline.update', subject: null }] }
export function register(app: any, Component: any) {
  app.createSettingSection({ id: 'image-pipeline', intlLabel: { id: 'image-pipeline.title', defaultMessage: 'Image Pipeline' } },
    [{ id: 'image-pipeline-settings', to: '/settings/image-pipeline',
      intlLabel: { id: 'image-pipeline.settings', defaultMessage: 'Settings' }, Component: async () => Component, permissions: permissions.read }])
  app.registerPlugin({ id: 'image-pipeline', name: 'Image Pipeline' })
}
