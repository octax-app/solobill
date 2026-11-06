import {
  type CustomField,
  type CustomFieldType,
  customItemsFor,
  type RenderLine,
  type RenderPayload,
} from '../../shared/render.ts'

interface SampleOptions {
  tax: boolean
  long: boolean
  arabic: boolean
}

const SAMPLE_VALUES: Record<CustomFieldType, string> = {
  text: 'ABC-123',
  number: '1000',
  date: '2026-11-01',
}

/** Sample data for the template preview. */
export function samplePayload(
  company: RenderPayload['company'],
  notes: string,
  taxRate: string,
  { tax, long, arabic }: SampleOptions,
  customFields: CustomField[] = [],
): RenderPayload {
  const base: RenderLine[] = [
    {
      description: arabic ? 'خادم مخصص، الاستضافة الشهرية' : 'Dedicated server, monthly hosting',
      quantity: '1',
      unitPrice: '120.000',
      taxRate: tax ? `${taxRate}%` : '',
      taxAmount: '6.000',
      total: tax ? '126.000' : '120.000',
    },
    {
      description: arabic ? 'نطاق example.com لمدة سنة' : 'Domain renewal, example.com',
      quantity: '2',
      unitPrice: '15.000',
      taxRate: tax ? `${taxRate}%` : '',
      taxAmount: '1.500',
      total: tax ? '31.500' : '30.000',
    },
  ]
  const lines = long
    ? Array.from({ length: 45 }, (_, index) => ({
        ...base[index % 2],
        description: `${base[index % 2].description} (${index + 1})`,
      }))
    : base
  return {
    title: tax ? 'Tax Invoice' : 'Invoice',
    meta: [
      { label: 'Number', value: 'INV-0001' },
      { label: 'Date', value: '2026-11-01' },
      { label: 'Due date', value: '2026-11-15' },
    ],
    customerLines: arabic
      ? ['شركة المثال للتجارة', 'مسقط، سلطنة عمان', 'الرقم الضريبي 1234567']
      : ['Example Trading LLC', 'Sara Ahmed', 'Muscat, Oman', 'Tax number: OM1234567'],
    lines,
    totals: [
      { label: 'Subtotal', value: '150.000 OMR' },
      { label: 'Discount', value: '-10.000 OMR' },
      ...(tax ? [{ label: `Tax (${taxRate}%)`, value: '7.000 OMR' }] : []),
      { label: 'Total', value: tax ? '147.000 OMR' : '140.000 OMR', strong: true },
    ],
    taxEnabled: tax,
    taxLines: [`Tax number: ${company.taxNumber || 'not set'}`, `Tax rate: ${taxRate}%`],
    company,
    notes,
    customItems: customItemsFor(
      customFields,
      Object.fromEntries(customFields.map((field) => [field.id, SAMPLE_VALUES[field.type]])),
    ),
  }
}
