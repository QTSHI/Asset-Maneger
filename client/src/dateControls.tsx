import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

const pad = (value: number) => String(value).padStart(2, "0");

export const today = () => {
  const value = new Date();
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
};

export const currentMonth = () => today().slice(0, 7);

export const shiftMonth = (month: string, amount: number) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const value = new Date(year, monthNumber - 1 + amount, 1, 12);
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}`;
};

export const monthLabel = (month: string) => {
  const [year, monthNumber] = month.split("-");
  return `${year} 年 ${Number(monthNumber)} 月`;
};

export function MonthNavigator({
  month,
  onChange,
  label = "查看月份",
}: {
  month: string;
  onChange: (month: string) => void;
  label?: string;
}) {
  return (
    <div className="month-navigator" aria-label={label}>
      <button
        type="button"
        aria-label="上一个月"
        title="上一个月"
        onClick={() => onChange(shiftMonth(month, -1))}
      >
        <ChevronLeft size={16} />
      </button>
      <label>
        <CalendarDays size={15} />
        <input
          type="month"
          aria-label="选择月份"
          value={month}
          onChange={(event) => event.target.value && onChange(event.target.value)}
        />
      </label>
      <button
        type="button"
        aria-label="下一个月"
        title="下一个月"
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        <ChevronRight size={16} />
      </button>
      <button
        type="button"
        className="today-button"
        disabled={month === currentMonth()}
        onClick={() => onChange(currentMonth())}
      >
        本月
      </button>
    </div>
  );
}
