// Web Audio / Audio EQ Cookbook normalized second-order filter coefficients.
export function biquadCoefficients(type,frequency,q,gain,rate) {
 const w=2*Math.PI*Math.max(0,Math.min(rate/2,frequency))/rate,c=Math.cos(w),s=Math.sin(w);
 const A=10**(gain/40),alpha=s/(2*Math.max(1e-12,['lowpass','highpass'].includes(type)?10**(q/20):q));
 let b0,b1,b2,a0=1+alpha,a1=-2*c,a2=1-alpha;
 switch(type){
 case 'lowpass':b0=(1-c)/2;b1=1-c;b2=b0;break;
 case 'highpass':b0=(1+c)/2;b1=-(1+c);b2=b0;break;
 case 'bandpass':b0=alpha;b1=0;b2=-alpha;break;
 case 'notch':b0=1;b1=-2*c;b2=1;break;
 case 'allpass':b0=1-alpha;b1=-2*c;b2=1+alpha;break;
 case 'peaking':b0=1+alpha*A;b1=-2*c;b2=1-alpha*A;a0=1+alpha/A;a2=1-alpha/A;break;
 case 'lowshelf':case 'highshelf':{
  const t=Math.sqrt(2*A)*s;
  if(type==='lowshelf'){
   b0=A*((A+1)-(A-1)*c+t);b1=2*A*((A-1)-(A+1)*c);b2=A*((A+1)-(A-1)*c-t);
   a0=(A+1)+(A-1)*c+t;a1=-2*((A-1)+(A+1)*c);a2=(A+1)+(A-1)*c-t;
  }else{
   b0=A*((A+1)+(A-1)*c+t);b1=-2*A*((A-1)+(A+1)*c);b2=A*((A+1)+(A-1)*c-t);
   a0=(A+1)-(A-1)*c+t;a1=2*((A-1)-(A+1)*c);a2=(A+1)-(A-1)*c-t;
  }break;
 }
 }
 return [b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
}
