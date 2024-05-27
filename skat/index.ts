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

const records = parse(csvString, {
    cast: true,
    cast_date: true,
    columns: true,
    skip_empty_lines: true,
});

type Record = {
    invoiceId: string;
    date: Date;
    name: string;
    type: 'A - Services' | 'A - Goods' | 'B - Services';
    inEu: boolean;
    inDk: boolean;
    grandTotal: number;
    vatRate: number;
    baseValue: number;
    vatValue: number;
};

// filter records from January 1st, 2024 to March 31st, 2024
const filteredRecords = records.filter((r: Record) => {
    const date = r.date;
    return date >= new Date(FROM_DATE) && date <= new Date(TO_DATE);
});

// console.log(filteredRecords);
// process.exit(0);

// Caclulate
// https://skat.dk/en-us/businesses/vat/vat-on-international-trade/reporting-your-international-trade
// https://skat.dk/erhverv/moms/moms-ved-handel-med-udlandet/indberet-din-handel-med-udlandet
const tax = {
    'vat-in-dk': 0, // Moms i DK til Købsmoms (Input VAT) (VAT deductible)

    // VAT on goods purchased outside Denmark (both the EU and third countries).
    'vat-on-goods-purchased-outside-denmark': 0,
    // VAT on services purchased outside Denmark subject to a reverse charge
    'vat-on-services-purchased-outside-denmark-subject-to-a-reverse-charge': 0,
    // to calculate Købsmoms (Input VAT) (VAT deductible)
    'vat-on-services-purchased-outside-denmark-outside-eu': 0,

    'eu-sales-with-vat': 0,
    'eu-sales-without-vat': 0,

    'vat-paid': 0, // Købsmoms
    'vat-collected': 0, // Salgsmoms

    // Boxes (base value here excl. VAT)
    'box-a-services': 0,
    'box-a-goods': 0,
    // Not relevant for my business
    'box-b-services': 0,
    'box-b-goods': 0,
    'box-c-services': 0,
};

tax['vat-in-dk'] = filteredRecords
    .filter((r: Record) => r.inDk)
    .filter((r: Record) => r.type === 'A - Services' || r.type === 'A - Goods')
    .reduce((acc: number, r: Record) => acc + r.vatValue, 0);

let vatOf25estimatedForReverseCharge = 0;

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
            vatOf25estimatedForReverseCharge += value;
        }

        return acc + value;
    }, 0);

// Moms af ydelseskøb i udlandet med omvendt betalingspligt
// VAT on services purchased outside Denmark subject to a reverse charge
tax['vat-on-services-purchased-outside-denmark-subject-to-a-reverse-charge'] =
    filteredRecords
        .filter((r: Record) => !r.inDk && r.inEu)
        // Only report the value of the EU services you purchased in box A - services.
        .filter((r: Record) => r.type === 'A - Services')
        .filter((r: Record) => r.vatRate === 0)
        .reduce((acc: number, r: Record) => {
            let value = r.vatValue;

            if (r.vatRate === 0) {
                value = r.grandTotal * 0.25;
                vatOf25estimatedForReverseCharge += value;
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
            vatOf25estimatedForReverseCharge += value;
        }

        return acc + value;
    }, 0);

// Print the manually added 25% on reverse charge
console.info({ vatOf25estimatedForReverseCharge });

// Købsmoms // Input VAT (VAT deductible)
// You may include amounts from the following fields:
// - VAT on goods purchased outside Denmark.
// - VAT on services purchased outside Denmark subject to a reverse charge.
tax['vat-paid'] =
    tax['vat-in-dk'] +
    tax['vat-on-goods-purchased-outside-denmark'] +
    tax[
        'vat-on-services-purchased-outside-denmark-subject-to-a-reverse-charge'
    ] +
    tax['vat-on-services-purchased-outside-denmark-outside-eu'];

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

// No sales for me... yet :)
// console.log(
//     `
// Report the value of your sale in two different places in E-tax for businesses:

// In your VAT return within the normal deadlines that apply to your business.
// Under ’EU-salg uden moms’ (EU sales exclusive of VAT) by the 25th day of each month.

//     `.trim(),
// );

// Round to no decimal places
Object.keys(tax).forEach((key) => {
    tax[key] = Math.round(tax[key]);
});

// Add Danish labels, it is easier to know where to put the numbers in the tax form
const dansk = {
    'Moms af varekøb i udlandet (både EU og lande uden for EU)':
        tax['vat-on-goods-purchased-outside-denmark'],
    'Moms af ydelseskøb i udlandet med omvendt betalingspligt':
        tax[
            'vat-on-services-purchased-outside-denmark-subject-to-a-reverse-charge'
        ],
    Købsmoms: tax['vat-paid'],
    'Rubrik A - varer': tax['box-a-goods'],
    'Rubrik A - ydelser': tax['box-a-services'],
    'Rubrik B - ydelser': tax['box-b-services'],
    'EU-salg med moms': tax['eu-sales-with-vat'],
    'EU-salg uden moms': tax['eu-sales-without-vat'],
};

console.dir(dansk);
