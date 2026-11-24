/** The 30 local government areas of Osun State and the short codes used in school numbers. */
export const LGAS: Record<string, string> = {
  'Atakumosa East': 'ATE',
  'Atakumosa West': 'ATW',
  Ayedaade: 'AYD',
  Ayedire: 'AYR',
  Boluwaduro: 'BLW',
  Boripe: 'BRP',
  'Ede North': 'EDN',
  'Ede South': 'EDS',
  Egbedore: 'EGB',
  Ejigbo: 'EJG',
  'Ife Central': 'IFC',
  'Ife East': 'IFE',
  'Ife North': 'IFN',
  'Ife South': 'IFS',
  Ifedayo: 'IFD',
  Ifelodun: 'IFL',
  Ila: 'ILA',
  'Ilesa East': 'ILE',
  'Ilesa West': 'ILW',
  Irepodun: 'IRP',
  Irewole: 'IRW',
  Isokan: 'ISK',
  Iwo: 'IWO',
  Obokun: 'OBK',
  'Odo Otin': 'ODO',
  'Ola Oluwa': 'OLA',
  Olorunda: 'OLR',
  Oriade: 'ORD',
  Orolu: 'ORL',
  Osogbo: 'OSG',
};

export const LGA_NAMES = Object.keys(LGAS);

export const LEVEL_CODES = {
  PRIMARY: 'PRI',
  JUNIOR_SECONDARY: 'JSS',
  SENIOR_SECONDARY: 'SSS',
  JUNIOR_AND_SENIOR: 'COM',
} as const;
