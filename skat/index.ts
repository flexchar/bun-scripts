import { parse } from 'csv-parse/sync';

const { SHEETS_CSV_URL, FROM_DATE, TO_DATE } = Bun.env;

if (!SHEETS_CSV_URL) {
    console.error('SHEETS_CSV_URL is required');
    process.exit(1);
}
if (!FROM_DATE) {
    console.error('FROM_DATE is required');
    process.exit(1);
}
if (!TO_DATE) {
    console.error('TO_DATE is required');
    process.exit(1);
}

const csvString = await (await fetch(SHEETS_CSV_URL)).text();

const initialRecords = parse(csvString, {
    cast: true,
    // cast_date: true,
    columns: true,
    skip_empty_lines: true,
});

type InitialRecord = {
    invoiceId: string;
    date: string;
    name: string;
    type: 'A - Services' | 'A - Goods' | 'B - Services';
    // Removed inEu/inDk columns; now we infer from VAT number
    vatNumber?: string | null;
    grandTotal: number;
    vatRate: number;
    baseValue: number;
    vatValue: number;
};

// Verify types using zod
import { z } from 'zod';
const recSchema = z.object({
    invoiceId: z.any(),
    date: z.string().transform((d) => new Date(d)),
    name: z.string(),
    type: z.enum(['A - Services', 'A - Goods', 'B - Services']),
    // Optional VAT number; when present we treat as EU
    vatNumber: z
        .string()
        .transform((s) => s?.toString?.() ?? '')
        .optional(),
    grandTotal: z.number(),
    vatRate: z.number(),
    baseValue: z.number(),
    vatValue: z.number(),
});

// Extend with derived flags so downstream filters keep working unchanged
type Record = z.infer<typeof recSchema> & { inEu: boolean; inDk: boolean };

const filteredRecords = initialRecords
    // Filter records for the period defined in .env
    .filter((r: InitialRecord) => {
        const date = new Date(r.date);
        return date >= new Date(FROM_DATE) && date <= new Date(TO_DATE);
    })
    .map((r: InitialRecord) => {
        try {
            const p = recSchema.parse(r);

            // Derived helpers
            const rawVat = (p.vatNumber ?? '').toString();
            const normalizedVat = rawVat.replace(/\s|-/g, '').toUpperCase();
            const isDk = normalizedVat.startsWith('DK');
            const hasVat = normalizedVat.length > 0;

            // Validations from notes:
            // - VAT rate is a multiplier, never higher than 1
            if (p.vatRate > 1) {
                throw new Error(
                    `Invalid vatRate ${p.vatRate} for invoice ${String(
                        p.invoiceId,
                    )}: vatRate must be a multiplier (<= 1)`,
                );
            }
            // - If DK VAT number, assert rate is 0.25
            if (isDk && p.vatRate !== 0.25) {
                throw new Error(
                    `Invalid vatRate ${p.vatRate} for invoice ${String(
                        p.invoiceId,
                    )}: DK transactions must have 0.25 VAT rate`,
                );
            }

            // Validate that B-type records always have negative amount
            // Aka, one cannot sell services/goods without earning money
            if (p.type.startsWith('B')) {
                if (p.baseValue >= 0) {
                    throw new Error(
                        `Invalid baseValue ${p.baseValue} for invoice ${String(
                            p.invoiceId,
                        )}: B-type records must have negative amount`,
                    );
                }
            }
            // Then perform the same for A-type records
            if (p.type.startsWith('A')) {
                if (p.baseValue <= 0) {
                    throw new Error(
                        `Invalid baseValue ${p.baseValue} for invoice ${String(
                            p.invoiceId,
                        )}: A-type records must have positive amount`,
                    );
                }
            }

            // Attach derived flags without changing the rest of the pipeline
            return {
                ...p,
                // emulate former fields via derived flags
                inEu: hasVat,
                inDk: isDk,
            } as Record;
        } catch (e) {
            const err: any = e;
            if (err?.errors) console.error(err.errors);
            else console.error(err);
            console.error(r);
            process.exit(1);
        }
    });
// console.log(filteredRecords);
// process.exit(0);

// Info
console.info(
    `Found ${filteredRecords.length} entries for the ${FROM_DATE} - ${TO_DATE} period.`,
);

// Caclulate
// https://skat.dk/en-us/businesses/vat/vat-on-international-trade/reporting-your-international-trade
// https://skat.dk/erhverv/moms/moms-ved-handel-med-udlandet/indberet-din-handel-med-udlandet
// New links because SKAT broke them once again
// https://skat.dk/en-us/businesses/vat/vat-on-international-trade/vat-on-sales-to-businesses/reporting-your-international-trade
// https://skat.dk/erhverv/moms/moms-ved-handel-med-udlandet/moms-ved-handel-med-virksomheder/indberet-din-handel-med-udlandet
const tax = {
    'vat-in-dk': 0, // Moms i DK til Købsmoms (Input VAT) (VAT deductible)

    // You calculate the VAT as 25% of the invoice value of the services purchased during the period.
    // This will be included in the Købsmoms (Input VAT) (VAT deductible)
    'manual-25-reverse-charge': 0, // manually added 25% on reverse charge

    // VAT on goods purchased outside Denmark (both the EU and third countries).
    'vat-on-goods-purchased-outside-denmark': 0,
    // VAT on services purchased outside Denmark subject to a reverse charge
    // to calculate Købsmoms (Input VAT) (VAT deductible)
    'vat-on-services-purchased-outside-denmark-subject-to-a-reverse-charge': 0,

    // to improve visibility, let's split in EU and outside EU
    'vat-on-services-purchased-outside-denmark-outside-eu': 0,
    'vat-on-services-purchased-outside-denmark-inside-eu': 0,

    'eu-sales-with-vat': 0,
    'eu-sales-without-vat': 0,

    'vat-paid': 0, // Købsmoms (Input VAT) (VAT deductible)
    'vat-collected': 0, // Salgsmoms (Output VAT) (VAT payable)

    // Boxes (base value here excl. VAT)
    'box-a-services': 0,
    'box-a-goods': 0,

    'box-b-services': 0,
    'box-b-goods': 0,
    'box-c-services': 0,
};

tax['vat-in-dk'] = filteredRecords
    .filter((r: Record) => r.inDk)
    .filter((r: Record) => r.type === 'A - Services' || r.type === 'A - Goods')
    .reduce((acc: number, r: Record) => acc + r.vatValue, 0);

// Moms af varekøb i udlandet (både EU og lande uden for EU)
// VAT on goods purchased outside Denmark (both the EU and third countries).
// Enter the VAT payable on services purchased outside Denmark during the VAT period (both EU countries and third countries).
// You calculate the VAT as 25% of the invoice value of the services purchased during the period.
tax['vat-on-goods-purchased-outside-denmark'] = filteredRecords
    .filter((r: Record) => !r.inDk)
    .filter((r: Record) => r.type === 'A - Goods')
    .reduce((acc: number, r: Record) => {
        let value = r.vatValue;

        if (r.vatRate === 0) {
            value = r.grandTotal * 0.25;
            tax['manual-25-reverse-charge'] += value;
        }

        return acc + value;
    }, 0);

// Moms af ydelseskøb i udlandet med omvendt betalingspligt
// VAT on services purchased outside Denmark subject to a reverse charge
// When you buy services from countries outside Denmark, both in and outside the EU, you must pay VAT on the purchase. You therefore have to calculate and pay Danish VAT on the service yourself.
// You calculate the VAT (25%) on the value of the service by first converting the value to Danish kroner. Then you multiply by 0.25.
tax['vat-on-services-purchased-outside-denmark-inside-eu'] = filteredRecords
    .filter((r: Record) => !r.inDk && r.inEu)
    // Only report the value of the EU services you purchased in box A - services.
    .filter((r: Record) => r.type === 'A - Services')
    .filter((r: Record) => r.vatRate === 0)
    .reduce((acc: number, r: Record) => {
        let value = r.vatValue;

        if (r.vatRate === 0) {
            value = r.grandTotal * 0.25;
            tax['manual-25-reverse-charge'] += value;
        }

        return acc + value;
    }, 0);

tax['vat-on-services-purchased-outside-denmark-outside-eu'] = filteredRecords
    .filter((r: Record) => !r.inDk && !r.inEu)
    .filter((r: Record) => r.type === 'A - Services')
    .reduce((acc: number, r: Record) => {
        let value = r.vatValue;

        if (r.vatRate === 0) {
            value = r.grandTotal * 0.25;
            tax['manual-25-reverse-charge'] += value;
        }

        return acc + value;
    }, 0);
tax['vat-on-services-purchased-outside-denmark-subject-to-a-reverse-charge'] =
    tax['vat-on-services-purchased-outside-denmark-inside-eu'] +
    tax['vat-on-services-purchased-outside-denmark-outside-eu'];

// Købsmoms // Input VAT (VAT deductible)
// You may include amounts from the following fields:
// - VAT on goods purchased outside Denmark.
// - VAT on services purchased outside Denmark subject to a reverse charge.
tax['vat-paid'] =
    tax['vat-in-dk'] +
    tax['vat-on-goods-purchased-outside-denmark'] +
    tax[
        'vat-on-services-purchased-outside-denmark-subject-to-a-reverse-charge'
    ];

// Box A - goods
// VAT on goods purchased outside Denmark (both the EU and third countries).
// You should report the value of your purchase of goods from other EU countries in box A - ‘goods’  on your VAT return.
// KISS: Hardware that I bought from the EU but not in Denmark
// Rubrik A - varer. Værdien uden moms af varekøb i andre EU-lande - EU-erhvervelser.
tax['box-a-goods'] = filteredRecords
    .filter((r: Record) => r.inEu && !r.inDk)
    .filter((r: Record) => r.type === 'A - Goods')
    .reduce((acc: number, r: Record) => acc + r.grandTotal, 0);

// Rubrik A - ydelser. Værdien uden moms af ydelseskøb i andre EU-lande.
// Box A - services
// You should report the value of your purchase of services from other EU countries in box A - ‘services’  on your VAT return.
// KISS: Services that I bought from the EU but not in Denmark, the base value w/o VAT
tax['box-a-services'] = filteredRecords
    .filter((r: Record) => r.inEu && !r.inDk)
    .filter((r: Record) => r.type === 'A - Services')
    .reduce((acc: number, r: Record) => acc + r.grandTotal, 0);

// Box B - services
// The value of certain sales of services exclusive of VAT to other EU countries. To be reported under ‘EU-salg uden moms’ (EU sales exclusive of VAT)
// Rubrik B-ydelser. Værdien af visse ydelsessalg uden moms til andre EU-lande. Skal også indberettes til systemet "EU-salg uden moms".
// KISS: Services that I sold to the EU without charging VAT (reverse charge) (typically B2B)
tax['box-b-services'] = filteredRecords
    .filter((r: Record) => r.inEu && !r.inDk)
    .filter((r: Record) => r.type === 'B - Services')
    .reduce((acc: number, r: Record) => acc + r.grandTotal, 0);

// Box C - services/goods
// The value of other goods and services sold exclusive of VAT in Denmark, other EU countries and countries outside the EU, see section 76 of the Executive Order
// Rubrik C. Værdien af andre varer og ydelser, der leveres uden afgift her i landet, i andre EU-lande og i lande uden for EU.
// KISS: bascically my sales anywhere that don't have VAT attached, typically B2B
tax['box-c-services'] = filteredRecords
    .filter((r: Record) => r.vatRate === 0)
    .filter((r: Record) => r.type === 'B - Services') // i don't sell goods so only services
    .reduce((acc: number, r: Record) => acc + r.baseValue, 0);
// Since sales are registered as negative numbers in my expenses sheet, we need to make them positive
tax['box-c-services'] = Math.abs(tax['box-c-services']);

// EU sales with VAT
// The value of certain sales of goods and services exclusive of VAT to other EU countries. To be reported under ‘EU-salg med moms’ (EU sales with VAT)
// KISS: Sales of goods and services to the EU where I charged VAT (typically B2C)
tax['eu-sales-with-vat'] = filteredRecords
    .filter((r: Record) => r.inEu && !r.inDk)
    .filter((r: Record) => r.type === 'B - Services')
    .filter((r: Record) => r.vatRate > 0)
    .reduce((acc: number, r: Record) => acc + r.grandTotal, 0);

// EU sales without VAT
// The value of certain sales of goods and services exclusive of VAT to other EU countries. To be reported under ‘EU-salg uden moms’ (EU sales exclusive of VAT)
tax['eu-sales-without-vat'] = filteredRecords
    .filter((r: Record) => r.inEu && !r.inDk)
    .filter((r: Record) => r.type === 'B - Services')
    .filter((r: Record) => r.vatRate === 0)
    .reduce((acc: number, r: Record) => acc + r.baseValue, 0);

tax['eu-sales-without-vat'] &&
    console.log(
        `
Report the value of your sale in two different places in E-tax for businesses:

In your VAT return within the normal deadlines that apply to your business.
Under ’EU-salg uden moms’ (EU sales exclusive of VAT) by the 25th day of each month.

    `.trim(),
    );

// Round to no decimal places
(Object.keys(tax) as Array<keyof typeof tax>).forEach((key) => {
    tax[key] = Math.round(tax[key]);
});

// Add Danish labels, it is easier to know where to put the numbers in the tax form
const dansk = {
    Salgsmoms: tax['vat-collected'],
    Købsmoms: tax['vat-paid'],

    'Moms af varekøb i udlandet (både EU og lande uden for EU)':
        tax['vat-on-goods-purchased-outside-denmark'],
    'Moms af ydelseskøb i udlandet med omvendt betalingspligt':
        tax[
            'vat-on-services-purchased-outside-denmark-subject-to-a-reverse-charge'
        ],

    'Rubrik A - varer': tax['box-a-goods'],
    'Rubrik A - ydelser': tax['box-a-services'],
    'Rubrik B - ydelser': tax['box-b-services'],
    'Rubrik B - varer': tax['box-b-goods'],
    'Rubrik C': tax['box-c-services'],
    'EU-salg med moms': tax['eu-sales-with-vat'],
    'EU-salg uden moms': tax['eu-sales-without-vat'],
};

// Add English labels, it is easier to know where to put the numbers in the tax form
const english = {
    'Output VAT (VAT payable)': tax['vat-collected'],
    'Input VAT (VAT deductible)': tax['vat-paid'],

    'VAT on goods purchased abroad (both the EU and third countries)':
        tax['vat-on-goods-purchased-outside-denmark'],
    'VAT on services purchased abroad subject to a reverse charge':
        tax[
            'vat-on-services-purchased-outside-denmark-subject-to-a-reverse-charge'
        ],

    'Box A - goods': tax['box-a-goods'],
    'Box A - services': tax['box-a-services'],
    'Box B - services': tax['box-b-services'],
    'Box B - goods': tax['box-b-goods'],
    'Box C': tax['box-c-services'],
    'EU sales with VAT': tax['eu-sales-with-vat'],
    'EU sales exclusive of VAT': tax['eu-sales-without-vat'],
};

console.log(tax);
console.dir(english);
console.dir(dansk);
