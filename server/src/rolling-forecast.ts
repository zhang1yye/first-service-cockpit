type ForecastInput={annualIncome:number|null;annualCost:number|null;ytdIncome:number|null;ytdCost:number|null;month:string;manualIncome?:number|null;manualCost?:number|null;explanation?:string}
const round=(v:number)=>Math.round(v*100)/100
export function calculateRollingForecast(input:ForecastInput){
  const elapsedMonths=Number(String(input.month).slice(5,7))
  if(!Number.isInteger(elapsedMonths)||elapsedMonths<1||elapsedMonths>12)throw new Error('月份格式无效')
  const actualKnown=input.ytdIncome!==null&&input.ytdCost!==null&&Number.isFinite(Number(input.ytdIncome))&&Number.isFinite(Number(input.ytdCost))
  if(!actualKnown)return{month:input.month,elapsedMonths,method:'unknown',calculatedIncome:null,calculatedCost:null,forecastIncome:null,forecastCost:null,incomeVariance:null,costVariance:null,forecastProfit:null,forecastProfitRate:null,explanation:'累计实际数据缺失'}
  const calculatedIncome=round(Number(input.ytdIncome)/elapsedMonths*12),calculatedCost=round(Number(input.ytdCost)/elapsedMonths*12)
  const hasManual=input.manualIncome!==undefined&&input.manualIncome!==null||input.manualCost!==undefined&&input.manualCost!==null
  if(hasManual&&!String(input.explanation||'').trim())throw new Error('人工覆盖预测必须填写差异说明')
  const forecastIncome=round(hasManual&&input.manualIncome!=null?Number(input.manualIncome):calculatedIncome),forecastCost=round(hasManual&&input.manualCost!=null?Number(input.manualCost):calculatedCost)
  const annualIncome=Number(input.annualIncome||0),annualCost=Number(input.annualCost||0),forecastProfit=round(forecastIncome-forecastCost)
  return{month:input.month,elapsedMonths,method:hasManual?'manual-override':'annualized-ytd',calculatedIncome,calculatedCost,forecastIncome,forecastCost,incomeVariance:round(forecastIncome-annualIncome),costVariance:round(forecastCost-annualCost),forecastProfit,forecastProfitRate:forecastIncome>0?round(forecastProfit/forecastIncome*100):0,explanation:String(input.explanation||'').trim()}
}
