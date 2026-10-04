import { useMemo, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type Country = { code: string; flag: string; name: string; short: string };

// Countries kept at the top of the list for quick access (primary markets).
const PRIORITY: Country[] = [
  { code: '256', flag: '🇺🇬', name: 'Uganda', short: 'UG' },
  { code: '254', flag: '🇰🇪', name: 'Kenya', short: 'KE' },
  { code: '255', flag: '🇹🇿', name: 'Tanzania', short: 'TZ' },
  { code: '250', flag: '🇷🇼', name: 'Rwanda', short: 'RW' },
  { code: '257', flag: '🇧🇮', name: 'Burundi', short: 'BI' },
  { code: '211', flag: '🇸🇸', name: 'South Sudan', short: 'SS' },
];

// Full global list (alphabetical). Includes the priority markets again so the
// composite COUNTRIES array stays the single source of truth.
const ALL: Country[] = [
  { code: '93', flag: '🇦🇫', name: 'Afghanistan', short: 'AF' },
  { code: '355', flag: '🇦🇱', name: 'Albania', short: 'AL' },
  { code: '213', flag: '🇩🇿', name: 'Algeria', short: 'DZ' },
  { code: '376', flag: '🇦🇩', name: 'Andorra', short: 'AD' },
  { code: '244', flag: '🇦🇴', name: 'Angola', short: 'AO' },
  { code: '1268', flag: '🇦🇬', name: 'Antigua & Barbuda', short: 'AG' },
  { code: '54', flag: '🇦🇷', name: 'Argentina', short: 'AR' },
  { code: '374', flag: '🇦🇲', name: 'Armenia', short: 'AM' },
  { code: '61', flag: '🇦🇺', name: 'Australia', short: 'AU' },
  { code: '43', flag: '🇦🇹', name: 'Austria', short: 'AT' },
  { code: '994', flag: '🇦🇿', name: 'Azerbaijan', short: 'AZ' },
  { code: '1242', flag: '🇧🇸', name: 'Bahamas', short: 'BS' },
  { code: '973', flag: '🇧🇭', name: 'Bahrain', short: 'BH' },
  { code: '880', flag: '🇧🇩', name: 'Bangladesh', short: 'BD' },
  { code: '1246', flag: '🇧🇧', name: 'Barbados', short: 'BB' },
  { code: '375', flag: '🇧🇾', name: 'Belarus', short: 'BY' },
  { code: '32', flag: '🇧🇪', name: 'Belgium', short: 'BE' },
  { code: '501', flag: '🇧🇿', name: 'Belize', short: 'BZ' },
  { code: '229', flag: '🇧🇯', name: 'Benin', short: 'BJ' },
  { code: '975', flag: '🇧🇹', name: 'Bhutan', short: 'BT' },
  { code: '591', flag: '🇧🇴', name: 'Bolivia', short: 'BO' },
  { code: '387', flag: '🇧🇦', name: 'Bosnia & Herzegovina', short: 'BA' },
  { code: '267', flag: '🇧🇼', name: 'Botswana', short: 'BW' },
  { code: '55', flag: '🇧🇷', name: 'Brazil', short: 'BR' },
  { code: '673', flag: '🇧🇳', name: 'Brunei', short: 'BN' },
  { code: '359', flag: '🇧🇬', name: 'Bulgaria', short: 'BG' },
  { code: '226', flag: '🇧🇫', name: 'Burkina Faso', short: 'BF' },
  { code: '257', flag: '🇧🇮', name: 'Burundi', short: 'BI' },
  { code: '855', flag: '🇰🇭', name: 'Cambodia', short: 'KH' },
  { code: '237', flag: '🇨🇲', name: 'Cameroon', short: 'CM' },
  { code: '1', flag: '🇨🇦', name: 'Canada', short: 'CA' },
  { code: '238', flag: '🇨🇻', name: 'Cape Verde', short: 'CV' },
  { code: '236', flag: '🇨🇫', name: 'Central African Rep.', short: 'CF' },
  { code: '235', flag: '🇹🇩', name: 'Chad', short: 'TD' },
  { code: '56', flag: '🇨🇱', name: 'Chile', short: 'CL' },
  { code: '86', flag: '🇨🇳', name: 'China', short: 'CN' },
  { code: '57', flag: '🇨🇴', name: 'Colombia', short: 'CO' },
  { code: '269', flag: '🇰🇲', name: 'Comoros', short: 'KM' },
  { code: '242', flag: '🇨🇬', name: 'Congo', short: 'CG' },
  { code: '243', flag: '🇨🇩', name: 'DR Congo', short: 'CD' },
  { code: '506', flag: '🇨🇷', name: 'Costa Rica', short: 'CR' },
  { code: '225', flag: '🇨🇮', name: "Côte d'Ivoire", short: 'CI' },
  { code: '385', flag: '🇭🇷', name: 'Croatia', short: 'HR' },
  { code: '53', flag: '🇨🇺', name: 'Cuba', short: 'CU' },
  { code: '357', flag: '🇨🇾', name: 'Cyprus', short: 'CY' },
  { code: '420', flag: '🇨🇿', name: 'Czechia', short: 'CZ' },
  { code: '45', flag: '🇩🇰', name: 'Denmark', short: 'DK' },
  { code: '253', flag: '🇩🇯', name: 'Djibouti', short: 'DJ' },
  { code: '1767', flag: '🇩🇲', name: 'Dominica', short: 'DM' },
  { code: '1809', flag: '🇩🇴', name: 'Dominican Republic', short: 'DO' },
  { code: '593', flag: '🇪🇨', name: 'Ecuador', short: 'EC' },
  { code: '20', flag: '🇪🇬', name: 'Egypt', short: 'EG' },
  { code: '503', flag: '🇸🇻', name: 'El Salvador', short: 'SV' },
  { code: '240', flag: '🇬🇶', name: 'Equatorial Guinea', short: 'GQ' },
  { code: '291', flag: '🇪🇷', name: 'Eritrea', short: 'ER' },
  { code: '372', flag: '🇪🇪', name: 'Estonia', short: 'EE' },
  { code: '268', flag: '🇸🇿', name: 'Eswatini', short: 'SZ' },
  { code: '251', flag: '🇪🇹', name: 'Ethiopia', short: 'ET' },
  { code: '679', flag: '🇫🇯', name: 'Fiji', short: 'FJ' },
  { code: '358', flag: '🇫🇮', name: 'Finland', short: 'FI' },
  { code: '33', flag: '🇫🇷', name: 'France', short: 'FR' },
  { code: '241', flag: '🇬🇦', name: 'Gabon', short: 'GA' },
  { code: '220', flag: '🇬🇲', name: 'Gambia', short: 'GM' },
  { code: '995', flag: '🇬🇪', name: 'Georgia', short: 'GE' },
  { code: '49', flag: '🇩🇪', name: 'Germany', short: 'DE' },
  { code: '233', flag: '🇬🇭', name: 'Ghana', short: 'GH' },
  { code: '30', flag: '🇬🇷', name: 'Greece', short: 'GR' },
  { code: '1473', flag: '🇬🇩', name: 'Grenada', short: 'GD' },
  { code: '502', flag: '🇬🇹', name: 'Guatemala', short: 'GT' },
  { code: '224', flag: '🇬🇳', name: 'Guinea', short: 'GN' },
  { code: '245', flag: '🇬🇼', name: 'Guinea-Bissau', short: 'GW' },
  { code: '592', flag: '🇬🇾', name: 'Guyana', short: 'GY' },
  { code: '509', flag: '🇭🇹', name: 'Haiti', short: 'HT' },
  { code: '504', flag: '🇭🇳', name: 'Honduras', short: 'HN' },
  { code: '852', flag: '🇭🇰', name: 'Hong Kong', short: 'HK' },
  { code: '36', flag: '🇭🇺', name: 'Hungary', short: 'HU' },
  { code: '354', flag: '🇮🇸', name: 'Iceland', short: 'IS' },
  { code: '91', flag: '🇮🇳', name: 'India', short: 'IN' },
  { code: '62', flag: '🇮🇩', name: 'Indonesia', short: 'ID' },
  { code: '98', flag: '🇮🇷', name: 'Iran', short: 'IR' },
  { code: '964', flag: '🇮🇶', name: 'Iraq', short: 'IQ' },
  { code: '353', flag: '🇮🇪', name: 'Ireland', short: 'IE' },
  { code: '972', flag: '🇮🇱', name: 'Israel', short: 'IL' },
  { code: '39', flag: '🇮🇹', name: 'Italy', short: 'IT' },
  { code: '1876', flag: '🇯🇲', name: 'Jamaica', short: 'JM' },
  { code: '81', flag: '🇯🇵', name: 'Japan', short: 'JP' },
  { code: '962', flag: '🇯🇴', name: 'Jordan', short: 'JO' },
  { code: '7', flag: '🇰🇿', name: 'Kazakhstan', short: 'KZ' },
  { code: '254', flag: '🇰🇪', name: 'Kenya', short: 'KE' },
  { code: '965', flag: '🇰🇼', name: 'Kuwait', short: 'KW' },
  { code: '996', flag: '🇰🇬', name: 'Kyrgyzstan', short: 'KG' },
  { code: '856', flag: '🇱🇦', name: 'Laos', short: 'LA' },
  { code: '371', flag: '🇱🇻', name: 'Latvia', short: 'LV' },
  { code: '961', flag: '🇱🇧', name: 'Lebanon', short: 'LB' },
  { code: '266', flag: '🇱🇸', name: 'Lesotho', short: 'LS' },
  { code: '231', flag: '🇱🇷', name: 'Liberia', short: 'LR' },
  { code: '218', flag: '🇱🇾', name: 'Libya', short: 'LY' },
  { code: '423', flag: '🇱🇮', name: 'Liechtenstein', short: 'LI' },
  { code: '370', flag: '🇱🇹', name: 'Lithuania', short: 'LT' },
  { code: '352', flag: '🇱🇺', name: 'Luxembourg', short: 'LU' },
  { code: '261', flag: '🇲🇬', name: 'Madagascar', short: 'MG' },
  { code: '265', flag: '🇲🇼', name: 'Malawi', short: 'MW' },
  { code: '60', flag: '🇲🇾', name: 'Malaysia', short: 'MY' },
  { code: '960', flag: '🇲🇻', name: 'Maldives', short: 'MV' },
  { code: '223', flag: '🇲🇱', name: 'Mali', short: 'ML' },
  { code: '356', flag: '🇲🇹', name: 'Malta', short: 'MT' },
  { code: '222', flag: '🇲🇷', name: 'Mauritania', short: 'MR' },
  { code: '230', flag: '🇲🇺', name: 'Mauritius', short: 'MU' },
  { code: '52', flag: '🇲🇽', name: 'Mexico', short: 'MX' },
  { code: '373', flag: '🇲🇩', name: 'Moldova', short: 'MD' },
  { code: '377', flag: '🇲🇨', name: 'Monaco', short: 'MC' },
  { code: '976', flag: '🇲🇳', name: 'Mongolia', short: 'MN' },
  { code: '382', flag: '🇲🇪', name: 'Montenegro', short: 'ME' },
  { code: '212', flag: '🇲🇦', name: 'Morocco', short: 'MA' },
  { code: '258', flag: '🇲🇿', name: 'Mozambique', short: 'MZ' },
  { code: '95', flag: '🇲🇲', name: 'Myanmar', short: 'MM' },
  { code: '264', flag: '🇳🇦', name: 'Namibia', short: 'NA' },
  { code: '977', flag: '🇳🇵', name: 'Nepal', short: 'NP' },
  { code: '31', flag: '🇳🇱', name: 'Netherlands', short: 'NL' },
  { code: '64', flag: '🇳🇿', name: 'New Zealand', short: 'NZ' },
  { code: '505', flag: '🇳🇮', name: 'Nicaragua', short: 'NI' },
  { code: '227', flag: '🇳🇪', name: 'Niger', short: 'NE' },
  { code: '234', flag: '🇳🇬', name: 'Nigeria', short: 'NG' },
  { code: '389', flag: '🇲🇰', name: 'North Macedonia', short: 'MK' },
  { code: '47', flag: '🇳🇴', name: 'Norway', short: 'NO' },
  { code: '968', flag: '🇴🇲', name: 'Oman', short: 'OM' },
  { code: '92', flag: '🇵🇰', name: 'Pakistan', short: 'PK' },
  { code: '970', flag: '🇵🇸', name: 'Palestine', short: 'PS' },
  { code: '507', flag: '🇵🇦', name: 'Panama', short: 'PA' },
  { code: '675', flag: '🇵🇬', name: 'Papua New Guinea', short: 'PG' },
  { code: '595', flag: '🇵🇾', name: 'Paraguay', short: 'PY' },
  { code: '51', flag: '🇵🇪', name: 'Peru', short: 'PE' },
  { code: '63', flag: '🇵🇭', name: 'Philippines', short: 'PH' },
  { code: '48', flag: '🇵🇱', name: 'Poland', short: 'PL' },
  { code: '351', flag: '🇵🇹', name: 'Portugal', short: 'PT' },
  { code: '974', flag: '🇶🇦', name: 'Qatar', short: 'QA' },
  { code: '40', flag: '🇷🇴', name: 'Romania', short: 'RO' },
  { code: '7', flag: '🇷🇺', name: 'Russia', short: 'RU' },
  { code: '250', flag: '🇷🇼', name: 'Rwanda', short: 'RW' },
  { code: '1758', flag: '🇱🇨', name: 'Saint Lucia', short: 'LC' },
  { code: '685', flag: '🇼🇸', name: 'Samoa', short: 'WS' },
  { code: '378', flag: '🇸🇲', name: 'San Marino', short: 'SM' },
  { code: '239', flag: '🇸🇹', name: 'São Tomé & Príncipe', short: 'ST' },
  { code: '966', flag: '🇸🇦', name: 'Saudi Arabia', short: 'SA' },
  { code: '221', flag: '🇸🇳', name: 'Senegal', short: 'SN' },
  { code: '381', flag: '🇷🇸', name: 'Serbia', short: 'RS' },
  { code: '248', flag: '🇸🇨', name: 'Seychelles', short: 'SC' },
  { code: '232', flag: '🇸🇱', name: 'Sierra Leone', short: 'SL' },
  { code: '65', flag: '🇸🇬', name: 'Singapore', short: 'SG' },
  { code: '421', flag: '🇸🇰', name: 'Slovakia', short: 'SK' },
  { code: '386', flag: '🇸🇮', name: 'Slovenia', short: 'SI' },
  { code: '252', flag: '🇸🇴', name: 'Somalia', short: 'SO' },
  { code: '27', flag: '🇿🇦', name: 'South Africa', short: 'ZA' },
  { code: '82', flag: '🇰🇷', name: 'South Korea', short: 'KR' },
  { code: '211', flag: '🇸🇸', name: 'South Sudan', short: 'SS' },
  { code: '34', flag: '🇪🇸', name: 'Spain', short: 'ES' },
  { code: '94', flag: '🇱🇰', name: 'Sri Lanka', short: 'LK' },
  { code: '249', flag: '🇸🇩', name: 'Sudan', short: 'SD' },
  { code: '597', flag: '🇸🇷', name: 'Suriname', short: 'SR' },
  { code: '46', flag: '🇸🇪', name: 'Sweden', short: 'SE' },
  { code: '41', flag: '🇨🇭', name: 'Switzerland', short: 'CH' },
  { code: '963', flag: '🇸🇾', name: 'Syria', short: 'SY' },
  { code: '886', flag: '🇹🇼', name: 'Taiwan', short: 'TW' },
  { code: '992', flag: '🇹🇯', name: 'Tajikistan', short: 'TJ' },
  { code: '255', flag: '🇹🇿', name: 'Tanzania', short: 'TZ' },
  { code: '66', flag: '🇹🇭', name: 'Thailand', short: 'TH' },
  { code: '670', flag: '🇹🇱', name: 'Timor-Leste', short: 'TL' },
  { code: '228', flag: '🇹🇬', name: 'Togo', short: 'TG' },
  { code: '676', flag: '🇹🇴', name: 'Tonga', short: 'TO' },
  { code: '1868', flag: '🇹🇹', name: 'Trinidad & Tobago', short: 'TT' },
  { code: '216', flag: '🇹🇳', name: 'Tunisia', short: 'TN' },
  { code: '90', flag: '🇹🇷', name: 'Türkiye', short: 'TR' },
  { code: '993', flag: '🇹🇲', name: 'Turkmenistan', short: 'TM' },
  { code: '256', flag: '🇺🇬', name: 'Uganda', short: 'UG' },
  { code: '380', flag: '🇺🇦', name: 'Ukraine', short: 'UA' },
  { code: '971', flag: '🇦🇪', name: 'United Arab Emirates', short: 'AE' },
  { code: '44', flag: '🇬🇧', name: 'United Kingdom', short: 'GB' },
  { code: '1', flag: '🇺🇸', name: 'United States', short: 'US' },
  { code: '598', flag: '🇺🇾', name: 'Uruguay', short: 'UY' },
  { code: '998', flag: '🇺🇿', name: 'Uzbekistan', short: 'UZ' },
  { code: '678', flag: '🇻🇺', name: 'Vanuatu', short: 'VU' },
  { code: '58', flag: '🇻🇪', name: 'Venezuela', short: 'VE' },
  { code: '84', flag: '🇻🇳', name: 'Vietnam', short: 'VN' },
  { code: '967', flag: '🇾🇪', name: 'Yemen', short: 'YE' },
  { code: '260', flag: '🇿🇲', name: 'Zambia', short: 'ZM' },
  { code: '263', flag: '🇿🇼', name: 'Zimbabwe', short: 'ZW' },
];

// Composite list: priority markets first, then the rest of the world
// (excluding any already shown in the priority block).
const prioritySet = new Set(PRIORITY.map((c) => c.short));
const COUNTRIES: Country[] = [
  ...PRIORITY,
  ...ALL.filter((c) => !prioritySet.has(c.short)),
];

interface CountryCodeSelectProps {
  value: string;
  onChange: (code: string) => void;
  triggerClassName?: string;
}

export function CountryCodeSelect({ value, onChange, triggerClassName }: CountryCodeSelectProps) {
  const [search, setSearch] = useState('');
  const selected = COUNTRIES.find((c) => c.code === value);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return COUNTRIES;
    const digits = q.replace(/\D/g, '');
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.short.toLowerCase().includes(q) ||
        (digits && c.code.includes(digits)),
    );
  }, [search]);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("w-[90px] h-14 rounded-xl rounded-r-none border-r-0 px-2 text-base shrink-0", triggerClassName)}>
        <SelectValue>
          {selected ? `${selected.flag} +${selected.code}` : '+256'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-[320px]">
        <div className="sticky top-0 z-10 bg-popover p-2">
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search country or code…"
            className="h-9"
          />
        </div>
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground text-center">No matches</p>
        ) : (
          filtered.map((country) => (
            <SelectItem key={country.short} value={country.code}>
              <span className="flex items-center gap-2">
                <span>{country.flag}</span>
                <span className="text-sm">+{country.code}</span>
                <span className="text-xs text-muted-foreground">{country.name}</span>
              </span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

export { COUNTRIES };
