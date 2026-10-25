#!/usr/bin/env bash
# Synthesizes the placeholder sound effects for the video with ffmpeg alone.
# Nothing is sampled from anywhere, so there is no licence to track: we made them.
# Run from the repository root:  bash video/tools/make-sfx.sh
set -euo pipefail

out="video/assets/sfx"
mkdir -p "$out"
R=48000

# gen NAME DURATION "aevalsrc expression" "extra audio filters"
gen() {
  local name="$1" dur="$2" expr="$3" filt="${4:-anull}"
  ffmpeg -y -loglevel error -f lavfi -i "aevalsrc=${expr}:d=${dur}:s=${R}" \
    -af "${filt},alimiter=limit=0.9" -ac 1 -ar "$R" -c:a pcm_s16le "$out/${name}.wav"
  echo "wrote ${name}.wav (${dur}s)"
}

# 1. Cartoon pop: a fast downward sweep, 0.25 s. For "Run" clicks that go wrong.
gen pop 0.25 "'0.8*sin(2*PI*(1100-3200*t)*t)*exp(-t*16)'"

# 2. Mouse click: a very short noise burst.
gen click 0.06 "'0.9*(random(0)-0.5)*exp(-t*300)'" "highpass=f=1500"

# 3. Alarm sting: two alternating tones that fade, 1.4 s. The warning light.
gen alarm-sting 1.4 "'0.5*sin(2*PI*t*(if(lt(mod(t,0.28),0.14),880,660)))*exp(-t*1.1)'"

# 4. Low pulse for the panic: a 55 Hz drone with a 1.6 Hz throb, 10 s, faded in and out.
gen panic-pulse 10 "'0.7*sin(2*PI*55*t)*(0.6+0.4*sin(2*PI*1.6*t))+0.15*sin(2*PI*110*t)*(0.5+0.5*sin(2*PI*1.6*t))'" "afade=t=in:d=0.6,afade=t=out:st=9:d=1"

# 5. Relief chord: a soft C major chord that blooms and fades, 3.5 s.
gen relief-chord 3.5 "'0.18*(sin(2*PI*261.63*t)+sin(2*PI*329.63*t)+sin(2*PI*392*t)+0.5*sin(2*PI*523.25*t))*min(t/0.25,1)*exp(-t*0.55)'"

# 6. Snare-roll riser for the chaos montage: noise bursts that speed up and grow, 3 s.
gen snare-riser 3 "'(random(0)-0.5)*min(t/3,1)*(0.55+0.45*sin(2*PI*(7+11*t)*t))'" "highpass=f=900,afade=t=out:st=2.8:d=0.2"

# 7. Hazard tick-tock: a soft double click at about 1.5 Hz, 10 s, like the indicator relay.
gen hazard-tick 10 "'0.8*(random(0)-0.5)*exp(-mod(t,0.66)*130)+0.35*(random(1)-0.5)*exp(-mod(t+0.33,0.66)*130)'" "highpass=f=900,lowpass=f=6000"

# 8. Timelapse build, 15 s: ticks that speed up, a rising tone, ending on a chord.
gen timelapse-build 15 "'0.35*(random(0)-0.5)*exp(-mod(t,0.25-0.012*t)*140)+0.12*sin(2*PI*(180+60*t)*t)*min(t/15,1)+if(gt(t,14),0.12*(sin(2*PI*261.63*t)+sin(2*PI*329.63*t)+sin(2*PI*392*t))*exp(-(t-14)*1.5),0)'" "afade=t=out:st=14.4:d=0.6"

# 9. Car ride, 12 s: brown noise and a low engine hum, to put under the car scene. Loops cleanly enough.
ffmpeg -y -loglevel error -f lavfi -i "anoisesrc=d=12:c=brown:a=0.5:r=${R}" -f lavfi -i "aevalsrc='0.25*sin(2*PI*62*t)+0.1*sin(2*PI*124*t)':d=12:s=${R}" \
  -filter_complex "[0]lowpass=f=400[n];[n][1]amix=inputs=2:normalize=0,afade=t=in:d=0.4,afade=t=out:st=11.4:d=0.6,alimiter=limit=0.9" \
  -ac 1 -ar "$R" -c:a pcm_s16le "$out/car-ride.wav"
echo "wrote car-ride.wav (12s)"

# 10. Engine off: the hum falls away, 2 s. Use at the moment the driver switches the engine off.
gen engine-off 2 "'0.5*sin(2*PI*(70*exp(-t*2.2))*t)*exp(-t*1.6)'"

# 11. Mug set down: a short low knock, 0.4 s.
gen mug-down 0.4 "'0.6*sin(2*PI*180*t)*exp(-t*22)+0.3*(random(0)-0.5)*exp(-t*90)'"

echo "done: $(ls "$out"/*.wav | wc -l) files in $out"
