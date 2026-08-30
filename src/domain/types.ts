export type Paise = number;

/** Positive values are receivable; negative values are owed. */
export interface Balance {
  memberId: string;
  amountPaise: Paise;
}
