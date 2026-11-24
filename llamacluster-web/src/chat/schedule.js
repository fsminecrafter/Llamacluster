// /schedule HH:MM, MM-DD, HH:MM-MM-DD (or a date with year); same rules as the original.
export function parseSchedule(arg,now=new Date()){
  const parts=String(arg||'').trim().split(/\s+/).filter(Boolean);let time=null,date=null,used=0;
  const comb=/^(\d{2}:\d{2})-(\d{2}-\d{2})$/.exec(parts[0]||'');
  if(comb){time=comb[1];date=comb[2];used=1}else while(used<parts.length&&used<2){const x=parts[used];
    if(!time&&/^\d{2}:\d{2}$/.test(x)){time=x;used++;continue}if(!date&&/^(?:\d{4}-)?\d{2}-\d{2}$/.test(x)){date=x;used++;continue}break}
  const prompt=parts.slice(used).join(' ').trim();
  if(!prompt)throw new Error('Add the prompt after the optional time/date. Example: /schedule 09:00-11-28 check for new reports');
  if(!time&&!date)throw new Error('Include a time (HH:MM), a date (MM-DD), or both before the prompt.');
  const [h,mi]=(time||'09:00').split(':').map(Number);if(h>23||mi>59)throw new Error('Time must use 24-hour HH:MM format.');
  let y=now.getFullYear(),mo=now.getMonth()+1,d=now.getDate(),ey=false;
  if(date){const m=/^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(date);ey=!!m[1];if(ey)y=+m[1];mo=+m[2];d=+m[3]}
  const valid=x=>x.getFullYear()===y&&x.getMonth()===mo-1&&x.getDate()===d&&x.getHours()===h&&x.getMinutes()===mi;let due;
  if(date&&!ey){for(let c=now.getFullYear();c<=now.getFullYear()+8;c++){y=c;const x=new Date(y,mo-1,d,h,mi);if(valid(x)&&x>now){due=x;break}}if(!due)throw new Error('Date is not valid or has no upcoming occurrence.')}
  else if(date){due=new Date(y,mo-1,d,h,mi);if(!valid(due))throw new Error('Date or local time is not valid.');if(due<=now)throw new Error('That date and time has already passed.')}
  else{due=new Date(y,mo-1,d,h,mi);if(due<=now)due=new Date(y,mo-1,d+1,h,mi)}
  return{prompt,dueAt:due.getTime(),localTime:due.toLocaleString()};
}
